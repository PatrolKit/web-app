import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimeClockFoldService } from './fold.service';
import { sweepAt } from './sweep.util';
import { displayName } from '../common/util/person';
import type { ShiftResponse } from '../contracts/time-clock.contracts';

type ShiftWithRelations = Prisma.TimeClockShiftGetPayload<{
  include: {
    resort: { select: { name: true; timeZone: true } };
    patroller: { include: { membership: { select: { user: true } } } };
  };
}>;

export interface ShiftQuery {
  resortId?: string;
  status?: string;
  updatedSince?: string;
  from?: string;
  to?: string;
  dutyType?: string;
  pastSweep?: boolean;
}

@Injectable()
export class ShiftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foldService: TimeClockFoldService,
  ) {}

  /**
   * Devices call this with `updatedSince` and no `resortId`: they cache every open shift
   * in the org (D13) plus anything closed since their cursor, which is how an iPad that
   * was off overnight learns yesterday's shifts are closed.
   */
  async list(orgId: string, q: ShiftQuery): Promise<ShiftResponse[]> {
    const where: Prisma.TimeClockShiftWhereInput = { orgId };
    if (q.resortId) where.resortId = q.resortId;
    if (q.dutyType) where.dutyType = q.dutyType;
    if (q.status) where.status = q.status;

    if (q.from || q.to) {
      where.clockInAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }

    if (q.updatedSince && !q.status) {
      where.OR = [{ status: 'open' }, { updatedAt: { gt: new Date(q.updatedSince) } }];
    } else if (q.updatedSince) {
      where.updatedAt = { gt: new Date(q.updatedSince) };
    }

    const shifts = await this.prisma.timeClockShift.findMany({
      where,
      include: {
        resort: { select: { name: true, timeZone: true } },
        patroller: { include: { membership: { select: { user: true } } } },
      },
      orderBy: { clockInAt: 'desc' },
      take: 2000,
    });

    const filtered = q.pastSweep ? await this.onlyPastSweep(orgId, shifts) : shifts;
    return filtered.map(toResponse);
  }

  /**
   * The admin "still open" view (§6.4): open shifts whose sweep has come and gone, which
   * means no device was around to close them.
   */
  private async onlyPastSweep(
    orgId: string,
    shifts: ShiftWithRelations[],
  ): Promise<ShiftWithRelations[]> {
    const settings = await this.prisma.timeClockSettings.findUnique({ where: { orgId } });
    const localTime = settings?.autoCloseLocalTime ?? '03:00';
    const now = Date.now();
    return shifts.filter(
      (s) =>
        s.status === 'open' &&
        sweepAt(s.clockInAt, s.resort.timeZone, localTime).getTime() < now,
    );
  }

  /**
   * Admin correction (§6.2). Rewrites the underlying events rather than the shift row —
   * events are the source of truth, so a correction written straight onto the shift would
   * be undone by the next recompute. Re-sourcing an event as `admin` also clears the
   * review flag, deterministically and in a way that survives replay.
   */
  async patch(
    orgId: string,
    shiftId: string,
    userId: string | undefined,
    data: {
      clockInAt?: string;
      clockOutAt?: string | null;
      dutyType?: string;
      dutyNote?: string | null;
    },
  ): Promise<ShiftResponse> {
    const shift = await this.prisma.timeClockShift.findFirst({ where: { id: shiftId, orgId } });
    if (!shift) throw new NotFoundException('Shift not found');

    const newClockIn = data.clockInAt ? new Date(data.clockInAt) : shift.clockInAt;
    const newClockOut =
      data.clockOutAt === undefined
        ? shift.clockOutAt
        : data.clockOutAt === null
          ? null
          : new Date(data.clockOutAt);

    if (newClockOut && newClockOut.getTime() < newClockIn.getTime()) {
      throw new BadRequestException('Clock-out cannot be before clock-in');
    }
    if (data.dutyNote && data.dutyType && data.dutyType !== 'other') {
      throw new BadRequestException("A duty note is only allowed when the duty type is 'other'");
    }

    await this.prisma.$transaction(
      async (tx) => {
        // The shift id is its clock-in event id (§5.6).
        await tx.timeClockEvent.update({
          where: { id: shift.id },
          data: {
            occurredAt: newClockIn,
            source: 'admin',
            ...(data.dutyType !== undefined ? { dutyType: data.dutyType } : {}),
            ...(data.dutyNote !== undefined ? { dutyNote: data.dutyNote } : {}),
          },
        });

        const closingEvent = await tx.timeClockEvent.findFirst({
          where: {
            orgId,
            patrollerId: shift.patrollerId,
            type: 'clock_out',
            occurredAt: shift.clockOutAt ?? undefined,
          },
          orderBy: { occurredAt: 'desc' },
        });

        if (newClockOut) {
          if (closingEvent) {
            await tx.timeClockEvent.update({
              where: { id: closingEvent.id },
              data: { occurredAt: newClockOut, source: 'admin' },
            });
          } else {
            await tx.timeClockEvent.create({
              data: {
                id: `admin-close:${shift.id}`,
                orgId,
                resortId: shift.resortId,
                patrollerId: shift.patrollerId,
                type: 'clock_out',
                source: 'admin',
                occurredAt: newClockOut,
                statusNote: userId ? `Closed by user ${userId}` : 'Closed by an administrator',
              },
            });
          }
        } else if (closingEvent) {
          // Re-opening a shift: drop the close entirely.
          await tx.timeClockEvent.delete({ where: { id: closingEvent.id } });
        }

        await this.foldService.recomputeForPatroller(orgId, shift.patrollerId, tx);
        await tx.timeClockShift.update({
          where: { id: shift.id },
          data: { editedByUserId: userId ?? null },
        });
      },
      { timeout: 20_000 },
    );

    const updated = await this.prisma.timeClockShift.findFirstOrThrow({
      where: { id: shiftId },
      include: {
        resort: { select: { name: true, timeZone: true } },
        patroller: { include: { membership: { select: { user: true } } } },
      },
    });
    return toResponse(updated);
  }
}

function toResponse(s: ShiftWithRelations): ShiftResponse {
  return {
    id: s.id,
    orgId: s.orgId,
    resortId: s.resortId,
    resortName: s.resort?.name ?? null,
    patrollerId: s.patrollerId,
    patrollerName: s.patroller ? displayName(s.patroller.membership.user) : null,
    patrolLevel: s.patroller?.membership.user.patrolLevel ?? null,
    nspId: s.patroller?.membership.user.nspId ?? null,
    dutyType: s.dutyType,
    dutyNote: s.dutyNote,
    clockInAt: s.clockInAt.toISOString(),
    clockOutAt: s.clockOutAt ? s.clockOutAt.toISOString() : null,
    status: s.status,
    closeReason: s.closeReason,
    flagged: s.flagged,
    updatedAt: s.updatedAt.toISOString(),
  };
}
