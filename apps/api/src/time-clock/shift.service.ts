import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimeClockFoldService, writeAdminClose } from './fold.service';
import { sweepAt } from './sweep.util';
import { displayName } from '../common/util/person';
import { afterCursor, decodeCursor, encodeCursor } from '../common/util/cursor';
import { seasonWhere } from './season.service';
import type {
  ShiftHistoryResponse,
  ShiftListQuery,
  ShiftPageResponse,
  ShiftResponse,
} from '../contracts/time-clock.contracts';

const SHIFT_INCLUDE = {
  resort: { select: { name: true, timeZone: true } },
  patroller: { include: { membership: { select: { user: true } } } },
} as const;

type ShiftWithRelations = Prisma.TimeClockShiftGetPayload<{ include: typeof SHIFT_INCLUDE }>;

/** A walk's page (D7): big enough that a normal day is one request. */
const WALK_PAGE = 500;
/** What the bare array has always been capped at, kept for the iPads that read it. */
const LEGACY_CAP = 2000;

type Correction = {
  clockInAt?: string;
  clockOutAt?: string | null;
  dutyType?: string;
  dutyNote?: string | null;
};

@Injectable()
export class ShiftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foldService: TimeClockFoldService,
  ) {}

  /**
   * Three readers, three shapes (Plan 55 D7):
   *
   * - `walk=true` is a device's delta: every shift changed since its cursor, tombstones
   *   included, paged in `(updatedAt, id)` order with `syncedAt` as the next cursor.
   * - `take` is a screen's page: newest first, with a total, never a tombstone.
   * - Neither is the bare array older iPad builds read, unchanged but for tombstones.
   */
  async list(orgId: string, q: ShiftListQuery): Promise<ShiftResponse[] | ShiftPageResponse> {
    if (q.walk || q.after) return this.walk(orgId, q);

    const where = await this.whereOf(orgId, q);
    if (q.take === undefined) {
      // The legacy delta: every open shift in the org (D13) plus anything changed since the
      // cursor, which is how an iPad off overnight learns yesterday's shifts are closed.
      if (q.updatedSince && !q.status) {
        where.AND = [
          ...asArray(where.AND),
          { OR: [{ status: 'open' }, { updatedAt: { gt: new Date(q.updatedSince) } }] },
        ];
      }
      const shifts = await this.prisma.timeClockShift.findMany({
        where,
        include: SHIFT_INCLUDE,
        orderBy: { clockInAt: 'desc' },
        take: LEGACY_CAP,
      });
      const filtered = q.pastSweep ? await this.onlyPastSweep(orgId, shifts) : shifts;
      return filtered.map(toResponse);
    }

    const syncedAt = new Date();
    if (q.pastSweep) {
      // Past the sweep depends on each shift's own zone, so it is filtered here rather
      // than in SQL. Open shifts are few; the page is cut after the filter.
      const open = await this.prisma.timeClockShift.findMany({
        where: { ...where, status: 'open' },
        include: SHIFT_INCLUDE,
        orderBy: { clockInAt: 'desc' },
      });
      const stale = await this.onlyPastSweep(orgId, open);
      const skip = q.skip ?? 0;
      return {
        shifts: stale.slice(skip, skip + q.take).map(toResponse),
        total: stale.length,
        syncedAt: syncedAt.toISOString(),
      };
    }
    const [shifts, total] = await this.prisma.$transaction([
      this.prisma.timeClockShift.findMany({
        where,
        include: SHIFT_INCLUDE,
        orderBy: [{ clockInAt: 'desc' }, { id: 'asc' }],
        skip: q.skip ?? 0,
        take: q.take,
      }),
      this.prisma.timeClockShift.count({ where }),
    ]);
    return { shifts: shifts.map(toResponse), total, syncedAt: syncedAt.toISOString() };
  }

  /**
   * The delta as a keyset walk. `syncedAt` is taken before the read: a row committed
   * while the walk runs is then returned again next time rather than skipped for good.
   */
  private async walk(orgId: string, q: ShiftListQuery): Promise<ShiftPageResponse> {
    const syncedAt = new Date();
    const cursor = q.after ? decodeCursor(q.after) : null;
    if (q.after && !cursor) throw new BadRequestException('That page cursor is not one of ours.');

    const where: Prisma.TimeClockShiftWhereInput = {
      orgId,
      // A device with no cursor holds nothing, so it has no copy for a tombstone to remove.
      ...(q.updatedSince ? { updatedAt: { gt: new Date(q.updatedSince) } } : { deletedAt: null }),
      ...(q.resortId ? { resortId: q.resortId } : {}),
      ...(cursor ? { AND: [afterCursor(cursor)] } : {}),
    };
    const take = q.take ?? WALK_PAGE;
    const [shifts, total] = await this.prisma.$transaction([
      this.prisma.timeClockShift.findMany({
        where,
        include: SHIFT_INCLUDE,
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take,
      }),
      this.prisma.timeClockShift.count({ where }),
    ]);
    const last = shifts[shifts.length - 1];
    return {
      shifts: shifts.map(toResponse),
      total,
      syncedAt: syncedAt.toISOString(),
      ...(last && shifts.length === take ? { nextAfter: encodeCursor(last.updatedAt, last.id) } : {}),
    };
  }

  /**
   * A screen's filters, and the legacy delta's. Never a tombstone (D6): an older iPad
   * cannot read `deletedAt`, and would board a removed open shift as a live one.
   */
  private async whereOf(orgId: string, q: ShiftListQuery): Promise<Prisma.TimeClockShiftWhereInput> {
    const where: Prisma.TimeClockShiftWhereInput = { orgId, deletedAt: null };
    if (q.resortId) where.resortId = q.resortId;
    if (q.dutyType) where.dutyType = q.dutyType;
    if (q.status) where.status = q.status;
    if (q.flagged !== undefined) where.flagged = q.flagged;

    const and: Prisma.TimeClockShiftWhereInput[] = [];
    if (q.from || q.to) {
      and.push({
        clockInAt: {
          ...(q.from ? { gte: new Date(q.from) } : {}),
          ...(q.to ? { lte: new Date(q.to) } : {}),
        },
      });
    }
    if (q.season !== undefined) and.push(await seasonWhere(this.prisma, orgId, q.season));
    if (q.updatedSince && q.take !== undefined) and.push({ updatedAt: { gt: new Date(q.updatedSince) } });
    if (and.length) where.AND = and;
    return where;
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
   * Every correction is audited with what it replaced (D11).
   */
  async patch(
    orgId: string,
    shiftId: string,
    userId: string | undefined,
    data: Correction,
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
    await this.assertNoOverlap(shift, newClockIn, newClockOut);

    // The close side moves only when the correction names it, and a superseded shift's
    // "close" is the next shift's clock-in: saving it unchanged must not invent a
    // clock-out at that instant, which would close the next shift instead.
    const closeChanged = data.clockOutAt !== undefined && !sameInstant(newClockOut, shift.clockOutAt);
    const touchClose =
      data.clockOutAt !== undefined && (closeChanged || (newClockOut !== null && shift.closeEventId !== null));
    const reopening = touchClose && newClockOut === null;

    const before = snapshot(shift);
    await this.prisma.$transaction(
      async (tx) => {
        // The shift id is its clock-in event id (§5.6). Re-sourced only when the clock-in
        // itself changed, so a corrected clock-out still says the iPad recorded the start.
        const inChanged =
          !sameInstant(newClockIn, shift.clockInAt) || dutyType !== shift.dutyType || dutyNote !== shift.dutyNote;
        if (inChanged) {
          await tx.timeClockEvent.update({
            where: { id: shift.id },
            data: { occurredAt: newClockIn, source: 'admin', dutyType, dutyNote },
          });
        }

        if (touchClose) {
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
        const after = await tx.timeClockShift.update({
          where: { id: shift.id },
          data: { editedByUserId: userId ?? null },
        });
        await tx.auditLog.create({
          data: {
            actorType: 'user',
            actorId: userId ?? null,
            orgId,
            action: reopening ? 'time_clock.shift.reopened' : 'time_clock.shift.corrected',
            targetType: 'time_clock_shift',
            targetId: shift.id,
            metadata: { before, after: snapshot(after) } as Prisma.InputJsonValue,
          },
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

  /**
   * A correction may not run into the patroller's next shift, or back into the one before:
   * the fold would read the overlap as a clock-in superseding an open shift, and close the
   * wrong one.
   */
  private async assertNoOverlap(
    shift: { id: string; orgId: string; patrollerId: string; clockInAt: Date },
    clockIn: Date,
    clockOut: Date | null,
  ): Promise<void> {
    const [next, previous] = await Promise.all([
      this.prisma.timeClockShift.findFirst({
        where: {
          orgId: shift.orgId, patrollerId: shift.patrollerId, deletedAt: null,
          id: { not: shift.id }, clockInAt: { gt: shift.clockInAt },
        },
        orderBy: { clockInAt: 'asc' },
      }),
      this.prisma.timeClockShift.findFirst({
        where: {
          orgId: shift.orgId, patrollerId: shift.patrollerId, deletedAt: null,
          id: { not: shift.id }, clockInAt: { lt: shift.clockInAt },
        },
        orderBy: { clockInAt: 'desc' },
      }),
    ]);
    if (next && (clockOut === null || clockOut.getTime() > next.clockInAt.getTime())) {
      throw new BadRequestException(
        clockOut === null
          ? 'This shift cannot be reopened: the patroller has a later shift. Correct that one instead.'
          : `That runs into the patroller's next shift, which starts at ${next.clockInAt.toISOString()}.`,
      );
    }
    if (previous?.clockOutAt && clockIn.getTime() < previous.clockOutAt.getTime()) {
      throw new BadRequestException(
        `That starts before the patroller's previous shift ended, at ${previous.clockOutAt.toISOString()}.`,
      );
    }
  }

  /** The shift's events and every recorded change to it, oldest first (D11). */
  async history(orgId: string, shiftId: string): Promise<ShiftHistoryResponse> {
    const shift = await this.prisma.timeClockShift.findFirst({ where: { id: shiftId, orgId } });
    if (!shift) throw new NotFoundException('Shift not found');

    // Its own events by id, and whatever else the patroller's terminals sent while it ran:
    // a close set aside by a reopen is no longer the shift's, but is still its story.
    const knownIds = [shift.id, shift.closeEventId, `admin-close:${shift.id}`, `admin-deactivate:${shift.id}`, `auto:${shift.id}`]
      .filter((id): id is string => !!id);
    const [events, audits] = await Promise.all([
      this.prisma.timeClockEvent.findMany({
        where: {
          orgId,
          OR: [
            { id: { in: [...new Set(knownIds)] } },
            {
              patrollerId: shift.patrollerId,
              type: 'clock_out',
              occurredAt: { gte: shift.clockInAt, lte: shift.clockOutAt ?? new Date() },
            },
          ],
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.auditLog.findMany({
        where: { orgId, targetType: 'time_clock_shift', targetId: shift.id },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const deviceIds = [...new Set(events.map((e) => e.deviceId).filter((d): d is string => !!d))];
    const actorIds = [...new Set(audits.map((a) => a.actorId).filter((a): a is string => !!a))];
    const [devices, actors] = await Promise.all([
      this.prisma.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: actorIds } } }),
    ]);
    const deviceName = new Map(devices.map((d) => [d.id, d.name]));
    const actorName = new Map(actors.map((u) => [u.id, displayName(u)]));

    return {
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        source: e.source,
        status: e.status,
        statusNote: e.statusNote,
        occurredAt: e.occurredAt.toISOString(),
        recordedAt: e.recordedAt.toISOString(),
        deviceName: e.deviceId ? deviceName.get(e.deviceId) ?? null : null,
      })),
      changes: audits.map((a) => {
        const m = (a.metadata ?? {}) as { before?: Record<string, unknown>; after?: Record<string, unknown> };
        return {
          action: a.action,
          actorName: a.actorId ? actorName.get(a.actorId) ?? null : null,
          at: a.createdAt.toISOString(),
          before: m.before ?? null,
          after: m.after ?? null,
        };
      }),
    };
  }
}

/** What an audit row keeps of a shift: enough to say what a correction replaced. */
function snapshot(s: {
  clockInAt: Date; clockOutAt: Date | null; dutyType: string; dutyNote: string | null;
  status: string; closeReason: string | null; flagged: boolean;
}) {
  return {
    clockInAt: s.clockInAt.toISOString(),
    clockOutAt: s.clockOutAt?.toISOString() ?? null,
    dutyType: s.dutyType,
    dutyNote: s.dutyNote,
    status: s.status,
    closeReason: s.closeReason,
    flagged: s.flagged,
  };
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
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
    dutyType: s.dutyType,
    dutyNote: s.dutyNote,
    clockInAt: s.clockInAt.toISOString(),
    clockOutAt: s.clockOutAt ? s.clockOutAt.toISOString() : null,
    status: s.status,
    closeReason: s.closeReason,
    flagged: s.flagged,
    edited: s.editedByUserId !== null,
    deletedAt: s.deletedAt ? s.deletedAt.toISOString() : null,
    updatedAt: s.updatedAt.toISOString(),
  };
}
