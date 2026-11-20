import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NOTE, TimeClockFoldService, writeAdminClose } from './fold.service';
import { TimeClockSweepService } from './sweep.service';
import { sweepAt } from './sweep.util';
import { displayName } from '../common/util/person';
import { afterCursor, decodeCursor, encodeCursor } from '../common/util/cursor';
import { seasonWhere } from './season.service';
import type {
  AddShift,
  PatrollerLogResponse,
  TimeEntryHistoryResponse,
  TimeEntryListQuery,
  TimeEntryPageResponse,
  TimeEntryResponse,
} from '../contracts/time-clock.contracts';

export const ENTRY_INCLUDE = {
  resort: { select: { name: true, timeZone: true } },
  patroller: { include: { membership: { select: { user: true } } } },
} as const;

type EntryWithRelations = Prisma.TimeEntryGetPayload<{ include: typeof ENTRY_INCLUDE }>;

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
export class TimeEntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foldService: TimeClockFoldService,
    private readonly sweepService: TimeClockSweepService,
  ) {}

  /**
   * Three readers, three shapes (Plan 55 D7):
   *
   * - `walk=true` is a device's delta: every entry changed since its cursor, tombstones
   *   included, paged in `(updatedAt, id)` order with `syncedAt` as the next cursor.
   * - `take` is a screen's page: newest first, with a total, never a tombstone.
   * - Neither is the bare array older iPad builds read, unchanged but for tombstones.
   */
  async list(orgId: string, q: TimeEntryListQuery): Promise<TimeEntryResponse[] | TimeEntryPageResponse> {
    if (q.walk || q.after) return this.walk(orgId, q);

    const where = await this.whereOf(orgId, q);
    if (q.take === undefined) {
      // The legacy delta: every open entry in the org (D13) plus anything changed since the
      // cursor, which is how an iPad off overnight learns yesterday's entries are closed.
      if (q.updatedSince && !q.status) {
        where.AND = [
          ...asArray(where.AND),
          { OR: [{ status: 'open' }, { updatedAt: { gt: new Date(q.updatedSince) } }] },
        ];
      }
      const entries = await this.prisma.timeEntry.findMany({
        where,
        include: ENTRY_INCLUDE,
        orderBy: { clockInAt: 'desc' },
        take: LEGACY_CAP,
      });
      const filtered = q.pastSweep ? await this.onlyPastSweep(orgId, entries) : entries;
      return filtered.map(toResponse);
    }

    const syncedAt = new Date();
    if (q.pastSweep) {
      // Past the sweep depends on each entry's own zone, so it is filtered here rather
      // than in SQL. Open entries are few; the page is cut after the filter.
      const open = await this.prisma.timeEntry.findMany({
        where: { ...where, status: 'open' },
        include: ENTRY_INCLUDE,
        orderBy: { clockInAt: 'desc' },
      });
      const stale = await this.onlyPastSweep(orgId, open);
      const skip = q.skip ?? 0;
      return {
        entries: stale.slice(skip, skip + q.take).map(toResponse),
        total: stale.length,
        syncedAt: syncedAt.toISOString(),
      };
    }
    const [entries, total] = await this.prisma.$transaction([
      this.prisma.timeEntry.findMany({
        where,
        include: ENTRY_INCLUDE,
        orderBy: [{ clockInAt: 'desc' }, { id: 'asc' }],
        skip: q.skip ?? 0,
        take: q.take,
      }),
      this.prisma.timeEntry.count({ where }),
    ]);
    return { entries: entries.map(toResponse), total, syncedAt: syncedAt.toISOString() };
  }

  /**
   * The delta as a keyset walk. `syncedAt` is taken before the read: a row committed
   * while the walk runs is then returned again next time rather than skipped for good.
   */
  private async walk(orgId: string, q: TimeEntryListQuery): Promise<TimeEntryPageResponse> {
    const syncedAt = new Date();
    const cursor = q.after ? decodeCursor(q.after) : null;
    if (q.after && !cursor) throw new BadRequestException('That page cursor is not one of ours.');

    const where: Prisma.TimeEntryWhereInput = {
      orgId,
      // A device with no cursor holds nothing, so it has no copy for a tombstone to remove.
      ...(q.updatedSince ? { updatedAt: { gt: new Date(q.updatedSince) } } : { deletedAt: null }),
      ...(q.resortId ? { resortId: q.resortId } : {}),
      ...(cursor ? { AND: [afterCursor(cursor)] } : {}),
    };
    const take = q.take ?? WALK_PAGE;
    const [entries, total] = await this.prisma.$transaction([
      this.prisma.timeEntry.findMany({
        where,
        include: ENTRY_INCLUDE,
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take,
      }),
      this.prisma.timeEntry.count({ where }),
    ]);
    const last = entries[entries.length - 1];
    return {
      entries: entries.map(toResponse),
      total,
      syncedAt: syncedAt.toISOString(),
      ...(last && entries.length === take ? { nextAfter: encodeCursor(last.updatedAt, last.id) } : {}),
    };
  }

  /**
   * A screen's filters, and the legacy delta's. Never a tombstone (D6): an older iPad
   * cannot read `deletedAt`, and would board a removed open entry as a live one.
   */
  private async whereOf(orgId: string, q: TimeEntryListQuery): Promise<Prisma.TimeEntryWhereInput> {
    const where: Prisma.TimeEntryWhereInput = { orgId, deletedAt: null };
    if (q.resortId) where.resortId = q.resortId;
    if (q.dutyType) where.dutyType = q.dutyType;
    if (q.status) where.status = q.status;
    if (q.flagged !== undefined) where.flagged = q.flagged;

    const and: Prisma.TimeEntryWhereInput[] = [];
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
   * The admin "still open" view (§6.4): open entries whose sweep has come and gone, which
   * means no device was around to close them.
   */
  private async onlyPastSweep(
    orgId: string,
    entries: EntryWithRelations[],
  ): Promise<EntryWithRelations[]> {
    const settings = await this.prisma.timeClockSettings.findUnique({ where: { orgId } });
    const localTime = settings?.autoCloseLocalTime ?? '03:00';
    const now = Date.now();
    return entries.filter(
      (s) =>
        s.status === 'open' &&
        sweepAt(s.clockInAt, s.resort.timeZone, localTime).getTime() < now,
    );
  }

  /**
   * Admin correction (§6.2). Rewrites the underlying events rather than the entry row —
   * events are the source of truth, so a correction written straight onto the entry would
   * be undone by the next recompute. Re-sourcing the close as `admin` also clears the
   * review flag, deterministically and in a way that survives replay.
   *
   * The close is the event the fold recorded as closing this entry (Plan 55 D1), never
   * one found by time. Reopening sets it aside as `voided` rather than deleting it (D2), so
   * a retry of the same id, or another iPad's late auto clock-out, cannot close it again.
   * Every correction is audited with what it replaced (D11).
   */
  async patch(
    orgId: string,
    entryId: string,
    userId: string | undefined,
    data: Correction,
  ): Promise<TimeEntryResponse> {
    let entry = await this.prisma.timeEntry.findFirst({
      where: { id: entryId, orgId, deletedAt: null },
    });
    if (!entry) throw new NotFoundException('Time entry not found');
    // An entry folded before the fold recorded its close (D1) learns it from one replay.
    if (entry.status === 'closed' && !entry.closeEventId) {
      await this.foldService.recomputeForPatroller(orgId, entry.patrollerId);
      entry = await this.prisma.timeEntry.findFirstOrThrow({ where: { id: entryId } });
    }

    const newClockIn = data.clockInAt ? new Date(data.clockInAt) : entry.clockInAt;
    const newClockOut =
      data.clockOutAt === undefined
        ? entry.clockOutAt
        : data.clockOutAt === null
          ? null
          : new Date(data.clockOutAt);

    if (newClockOut && newClockOut.getTime() < newClockIn.getTime()) {
      throw new BadRequestException('Clock-out cannot be before clock-in');
    }
    const dutyType = data.dutyType ?? entry.dutyType;
    const dutyNote = data.dutyNote !== undefined ? data.dutyNote : dutyType === 'other' ? entry.dutyNote : null;
    if (dutyNote && dutyType !== 'other') {
      throw new BadRequestException("A duty note is only allowed when the duty type is 'other'");
    }
    await this.assertNoOverlap(entry, newClockIn, newClockOut);

    // The close side moves only when the correction names it.
    const closeChanged = data.clockOutAt !== undefined && !sameInstant(newClockOut, entry.clockOutAt);
    const touchClose =
      data.clockOutAt !== undefined && (closeChanged || (newClockOut !== null && entry.closeEventId !== null));
    const reopening = touchClose && newClockOut === null;

    const before = snapshot(entry);
    await this.prisma.$transaction(
      async (tx) => {
        await keepDuplicates(tx, entry);
        // The entry id is its clock-in event id (§5.6). Re-sourced only when the clock-in
        // itself changed, so a corrected clock-out still says the iPad recorded the start.
        const inChanged =
          !sameInstant(newClockIn, entry.clockInAt) || dutyType !== entry.dutyType || dutyNote !== entry.dutyNote;
        if (inChanged) {
          await tx.timeClockEvent.update({
            where: { id: entry.id },
            data: { occurredAt: newClockIn, source: 'admin', dutyType, dutyNote },
          });
        }

        if (touchClose) {
          if (newClockOut) {
            if (entry.closeEventId) {
              await tx.timeClockEvent.update({
                where: { id: entry.closeEventId },
                data: { occurredAt: newClockOut, source: 'admin' },
              });
            } else {
              await writeAdminClose(tx, {
                id: `admin-close:${entry.id}`,
                orgId,
                resortId: entry.resortId,
                patrollerId: entry.patrollerId,
                entryId: entry.id,
                occurredAt: newClockOut,
                statusNote: userId ? `Closed by user ${userId}` : 'Closed by an administrator',
              });
            }
          } else {
            // Every close of it, not only the one that won: a close it lost to would
            // otherwise close it again on the replay (Plan 59 E5, E11).
            await tx.timeClockEvent.updateMany({
              where: {
                orgId,
                type: 'clock_out',
                status: { notIn: ['voided', 'rejected'] },
                OR: [{ entryId: entry.id }, ...(entry.closeEventId ? [{ id: entry.closeEventId }] : [])],
              },
              data: {
                status: 'voided',
                statusNote: userId
                  ? `Set aside by user ${userId} when the entry was reopened`
                  : 'Set aside when the entry was reopened',
              },
            });
          }
        }

        await this.foldService.recomputeForPatroller(orgId, entry.patrollerId, tx);
        const after = await tx.timeEntry.update({
          where: { id: entry.id },
          data: { editedByUserId: userId ?? null },
        });
        await tx.auditLog.create({
          data: {
            actorType: 'user',
            actorId: userId ?? null,
            orgId,
            action: reopening ? 'time_clock.entry.reopened' : 'time_clock.entry.corrected',
            targetType: 'time_entry',
            targetId: entry.id,
            metadata: { before, after: snapshot(after) } as Prisma.InputJsonValue,
          },
        });
      },
      { timeout: 20_000 },
    );

    const updated = await this.prisma.timeEntry.findFirstOrThrow({
      where: { id: entryId },
      include: ENTRY_INCLUDE,
    });
    return toResponse(updated);
  }

  /**
   * Removes a shift (Plan 59 R8, E7): every event of it is set aside, its duplicates
   * included, so the replay drops it and nothing of it comes back.
   */
  async remove(orgId: string, entryId: string, userId: string | undefined): Promise<void> {
    const entry = await this.prisma.timeEntry.findFirst({ where: { id: entryId, orgId, deletedAt: null } });
    if (!entry) throw new NotFoundException('Time entry not found');
    const before = snapshot(entry);
    await this.prisma.$transaction(
      async (tx) => {
        await tx.timeClockEvent.updateMany({
          where: {
            orgId,
            patrollerId: entry.patrollerId,
            status: { not: 'rejected' },
            OR: [{ id: entry.id }, { entryId: entry.id }, ...(entry.closeEventId ? [{ id: entry.closeEventId }] : [])],
          },
          data: { status: 'voided', statusNote: userId ? `Removed by user ${userId}` : 'Removed by an administrator' },
        });
        await this.foldService.recomputeForPatroller(orgId, entry.patrollerId, tx);
        await tx.auditLog.create({
          data: {
            actorType: 'user',
            actorId: userId ?? null,
            orgId,
            action: 'time_clock.entry.removed',
            targetType: 'time_entry',
            targetId: entry.id,
            metadata: { before } as Prisma.InputJsonValue,
          },
        });
      },
      { timeout: 20_000 },
    );
  }

  /**
   * Staff add a whole shift (Plan 59 R8). It can't overlap another of hers (E7), and needs
   * its clock-out once its sweep moment has passed (E6).
   */
  async addShift(orgId: string, patrollerId: string, userId: string | undefined, body: AddShift): Promise<TimeEntryResponse> {
    const [patroller, resort, settings] = await Promise.all([
      this.prisma.patrollerProfile.findFirst({ where: { id: patrollerId, membership: { orgId } }, select: { id: true } }),
      this.prisma.resort.findFirst({ where: { id: body.resortId, orgId, deletedAt: null }, select: { id: true, timeZone: true } }),
      this.prisma.timeClockSettings.findUnique({ where: { orgId } }),
    ]);
    if (!patroller) throw new NotFoundException('Patroller not found');
    if (!resort) throw new NotFoundException('Resort not found');

    const clockIn = new Date(body.clockInAt);
    const clockOut = body.clockOutAt ? new Date(body.clockOutAt) : null;
    const latest = Date.now() + 5 * 60_000;
    if (clockIn.getTime() > latest || (clockOut && clockOut.getTime() > latest)) {
      throw new BadRequestException('A shift can’t be in the future.');
    }
    if (clockOut && clockOut.getTime() <= clockIn.getTime()) {
      throw new BadRequestException('Clock-out must be after clock-in.');
    }
    if (!clockOut && sweepAt(clockIn, resort.timeZone, settings?.autoCloseLocalTime ?? '03:00').getTime() <= Date.now()) {
      throw new BadRequestException({ message: 'Enter the whole shift: this one needs a clock-out.', code: 'needs_clock_out' });
    }

    await this.sweepService.sweep({ orgId, patrollerId });
    const overlap = await this.prisma.timeEntry.findFirst({
      where: {
        orgId,
        patrollerId,
        deletedAt: null,
        ...(clockOut ? { clockInAt: { lt: clockOut } } : {}),
        OR: [{ clockOutAt: null }, { clockOutAt: { gt: clockIn } }],
      },
      include: ENTRY_INCLUDE,
    });
    if (overlap) {
      throw new ConflictException({
        message: 'That overlaps another of her shifts. Correct or remove that one instead.',
        code: 'overlaps',
        details: { entry: toResponse(overlap) },
      });
    }

    const id = `admin-in:${createId()}`;
    await this.prisma.$transaction(
      async (tx) => {
        await tx.timeClockEvent.create({
          data: {
            id,
            orgId,
            resortId: resort.id,
            patrollerId,
            type: 'clock_in',
            dutyType: body.dutyType,
            dutyNote: body.dutyNote ?? null,
            source: 'admin',
            occurredAt: clockIn,
            statusNote: userId ? `Added by user ${userId}` : 'Added by an administrator',
          },
        });
        if (clockOut) {
          await writeAdminClose(tx, {
            id: `admin-close:${id}`,
            orgId,
            resortId: resort.id,
            patrollerId,
            entryId: id,
            occurredAt: clockOut,
            statusNote: userId ? `Closed by user ${userId}` : 'Closed by an administrator',
          });
        }
        await this.foldService.recomputeForPatroller(orgId, patrollerId, tx);
        const after = await tx.timeEntry.update({ where: { id }, data: { editedByUserId: userId ?? null } });
        await tx.auditLog.create({
          data: {
            actorType: 'user',
            actorId: userId ?? null,
            orgId,
            action: 'time_clock.entry.added',
            targetType: 'time_entry',
            targetId: id,
            metadata: { after: snapshot(after) } as Prisma.InputJsonValue,
          },
        });
      },
      { timeout: 20_000 },
    );
    const entry = await this.prisma.timeEntry.findFirstOrThrow({ where: { id }, include: ENTRY_INCLUDE });
    return toResponse(entry);
  }

  /**
   * A correction may not run into the patroller's next time entry, or back into the one before:
   * the fold would read the overlap as a clock-in superseding an open entry, and close the
   * wrong one.
   */
  private async assertNoOverlap(
    entry: { id: string; orgId: string; patrollerId: string; clockInAt: Date },
    clockIn: Date,
    clockOut: Date | null,
  ): Promise<void> {
    const [next, previous] = await Promise.all([
      this.prisma.timeEntry.findFirst({
        where: {
          orgId: entry.orgId, patrollerId: entry.patrollerId, deletedAt: null,
          id: { not: entry.id }, clockInAt: { gt: entry.clockInAt },
        },
        orderBy: { clockInAt: 'asc' },
      }),
      this.prisma.timeEntry.findFirst({
        where: {
          orgId: entry.orgId, patrollerId: entry.patrollerId, deletedAt: null,
          id: { not: entry.id }, clockInAt: { lt: entry.clockInAt },
        },
        orderBy: { clockInAt: 'desc' },
      }),
    ]);
    if (next && (clockOut === null || clockOut.getTime() > next.clockInAt.getTime())) {
      throw new BadRequestException(
        clockOut === null
          ? 'This entry cannot be reopened: the patroller has a later entry. Correct that one instead.'
          : `That runs into the patroller's next time entry, which starts at ${next.clockInAt.toISOString()}.`,
      );
    }
    if (previous?.clockOutAt && clockIn.getTime() < previous.clockOutAt.getTime()) {
      throw new BadRequestException(
        `That starts before the patroller's previous time entry ended, at ${previous.clockOutAt.toISOString()}.`,
      );
    }
  }

  /** The entry's events and every recorded change to it, oldest first (D11). */
  /**
   * A patroller's events and entries, oldest first, for checking what the fold made of
   * them (iOS Plan 43). Removed entries are included, since a scenario may expect one.
   */
  async patrollerLog(orgId: string, patrollerId: string): Promise<PatrollerLogResponse> {
    const patroller = await this.prisma.patrollerProfile.findFirst({
      where: { id: patrollerId, membership: { orgId } },
      select: { id: true },
    });
    if (!patroller) throw new NotFoundException('Patroller not found');

    const [events, entries] = await Promise.all([
      this.prisma.timeClockEvent.findMany({
        where: { orgId, patrollerId },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: LEGACY_CAP,
      }),
      this.prisma.timeEntry.findMany({
        where: { orgId, patrollerId },
        include: ENTRY_INCLUDE,
        orderBy: [{ clockInAt: 'asc' }, { id: 'asc' }],
        take: LEGACY_CAP,
      }),
    ]);
    return {
      patrollerId,
      events: events.map((e) => ({
        id: e.id,
        resortId: e.resortId,
        type: e.type,
        dutyType: e.dutyType,
        dutyNote: e.dutyNote,
        source: e.source,
        status: e.status,
        statusNote: e.statusNote,
        occurredAt: e.occurredAt.toISOString(),
        recordedAt: e.recordedAt.toISOString(),
        deviceId: e.deviceId,
        entryId: e.entryId,
        sweepAt: e.sweepAt?.toISOString() ?? null,
        location: e.latitude !== null && e.longitude !== null ? { lat: e.latitude, lon: e.longitude, accuracyM: e.accuracyM } : null,
      })),
      entries: entries.map(toResponse),
    };
  }

  async history(orgId: string, entryId: string): Promise<TimeEntryHistoryResponse> {
    const entry = await this.prisma.timeEntry.findFirst({ where: { id: entryId, orgId } });
    if (!entry) throw new NotFoundException('Time entry not found');

    // Its own events by id, and whatever else the patroller's terminals sent while it ran:
    // a close set aside by a reopen is no longer the entry's, but is still its story.
    const knownIds = [entry.id, entry.closeEventId, `admin-close:${entry.id}`, `admin-deactivate:${entry.id}`, `auto:${entry.id}`]
      .filter((id): id is string => !!id);
    const [events, audits] = await Promise.all([
      this.prisma.timeClockEvent.findMany({
        where: {
          orgId,
          OR: [
            { id: { in: [...new Set(knownIds)] } },
            { entryId: entry.id },
            {
              patrollerId: entry.patrollerId,
              type: 'clock_out',
              occurredAt: { gte: entry.clockInAt, lte: entry.clockOutAt ?? new Date() },
            },
          ],
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.auditLog.findMany({
        // Rows written before Plan 58 name it a shift.
        where: { orgId, targetType: { in: ['time_entry', 'time_clock_shift'] }, targetId: entry.id },
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
          action: a.action.replace(/^time_clock\.shift\./, 'time_clock.entry.'),
          actorName: a.actorId ? actorName.get(a.actorId) ?? null : null,
          at: a.createdAt.toISOString(),
          before: m.before ?? null,
          after: m.after ?? null,
        };
      }),
    };
  }
}

/**
 * A staff edit keeps a shift's duplicate clock-ins duplicates (Plan 59 R2, E26): set aside,
 * still naming the shift, so the replay can't turn one into a shift of its own.
 */
async function keepDuplicates(
  tx: Prisma.TransactionClient,
  entry: { id: string; orgId: string; patrollerId: string },
): Promise<void> {
  await tx.timeClockEvent.updateMany({
    where: { orgId: entry.orgId, patrollerId: entry.patrollerId, type: 'clock_in', status: 'duplicate', entryId: entry.id },
    data: { status: 'voided', statusNote: NOTE.keptDuplicate },
  });
}

/** What an audit row keeps of an entry: enough to say what a correction replaced. */
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

export function toResponse(s: EntryWithRelations): TimeEntryResponse {
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
