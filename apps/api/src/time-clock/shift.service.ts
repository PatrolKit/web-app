import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimeClockFoldService, writeAdminClose } from './fold.service';
import { sweepAt } from './sweep.util';
import { displayName } from '../common/util/person';
import type { ShiftResponse } from '../contracts/time-clock.contracts';

const SHIFT_INCLUDE = {
  resort: { select: { name: true, timeZone: true } },
  patroller: { include: { membership: { select: { user: true } } } },
} as const;

type ShiftWithRelations = Prisma.TimeClockShiftGetPayload<{ include: typeof SHIFT_INCLUDE }>;

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
    // Tombstones only in a delta (Plan 55 D6): a device holding a mirror has to be told a
    // shift went, and a screen has no business showing one.
    const where: Prisma.TimeClockShiftWhereInput = { orgId, ...(q.updatedSince ? {} : { deletedAt: null }) };
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
      include: SHIFT_INCLUDE,
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
   * be undone by the next recompute. Re-sourcing the close as `admin` also clears the
   * review flag, deterministically and in a way that survives replay.
   *
   * The close is the event the fold recorded as closing this shift (Plan 55 D1), never
   * one found by time. Reopening sets it aside as `voided` rather than deleting it (D2), so
   * a retry of the same id, or another iPad's late auto clock-out, cannot close it again.
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
    let shift = await this.prisma.timeClockShift.findFirst({
      where: { id: shiftId, orgId, deletedAt: null },
    });
    if (!shift) throw new NotFoundException('Shift not found');
    // A shift folded before the fold recorded its close (D1) learns it from one replay.
    if (shift.status === 'closed' && !shift.closeEventId && shift.closeReason !== 'superseded') {
      await this.foldService.recomputeForPatroller(orgId, shift.patrollerId);
      shift = await this.prisma.timeClockShift.findFirstOrThrow({ where: { id: shiftId } });
    }

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
    const dutyType = data.dutyType ?? shift.dutyType;
    const dutyNote = data.dutyNote !== undefined ? data.dutyNote : dutyType === 'other' ? shift.dutyNote : null;
    if (dutyNote && dutyType !== 'other') {
      throw new BadRequestException("A duty note is only allowed when the duty type is 'other'");
    }

    await this.prisma.$transaction(
      async (tx) => {
        // The shift id is its clock-in event id (§5.6).
        await tx.timeClockEvent.update({
          where: { id: shift.id },
          data: { occurredAt: newClockIn, source: 'admin', dutyType, dutyNote },
        });

        // The close side moves only when the correction names it: a duty-type fix on a
        // superseded shift must not invent a clock-out at the next shift's clock-in.
        if (data.clockOutAt !== undefined) {
          if (newClockOut) {
            if (shift.closeEventId) {
              await tx.timeClockEvent.update({
                where: { id: shift.closeEventId },
                data: { occurredAt: newClockOut, source: 'admin' },
              });
            } else {
              await writeAdminClose(tx, {
                id: `admin-close:${shift.id}`,
                orgId,
                resortId: shift.resortId,
                patrollerId: shift.patrollerId,
                occurredAt: newClockOut,
                statusNote: userId ? `Closed by user ${userId}` : 'Closed by an administrator',
              });
            }
          } else if (shift.closeEventId) {
            await tx.timeClockEvent.update({
              where: { id: shift.closeEventId },
              data: {
                status: 'voided',
                statusNote: userId
                  ? `Set aside by user ${userId} when the shift was reopened`
                  : 'Set aside when the shift was reopened',
              },
            });
          }
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
      include: SHIFT_INCLUDE,
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
