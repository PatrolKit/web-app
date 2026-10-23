import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Folds a patroller's clock events into shifts (§5.5).
 *
 * The server never folds incrementally: whenever events land it replays that patroller's
 * whole log in `occurredAt` order, so the outcome is independent of arrival order. An
 * iPad offline all day can deliver a morning clock-in after another iPad has already
 * delivered the afternoon, and the result still converges.
 */

type FoldEvent = {
  id: string;
  resortId: string;
  type: string;
  dutyType: string | null;
  dutyNote: string | null;
  source: string;
  occurredAt: Date;
};

export type FoldedShift = {
  id: string;
  resortId: string;
  dutyType: string;
  dutyNote: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  status: 'open' | 'closed';
  closeReason: string | null;
  flagged: boolean;
  /** The clock-out that closed it (Plan 55 D1); null while open or when superseded. */
  closeEventId: string | null;
};

export type EventStatus = 'applied' | 'duplicate' | 'orphan' | 'anomalous' | 'rejected' | 'voided';

/** Statuses the fold never reads: refused on arrival, or set aside by an admin (D2). */
export const UNFOLDED_STATUSES = ['rejected', 'voided'] as const;

export interface FoldResult {
  shifts: FoldedShift[];
  eventStatus: Map<string, EventStatus>;
}

/** Pure replay of the §5.5 table. Exported for unit tests. */
export function foldEvents(events: FoldEvent[]): FoldResult {
  const ordered = [...events].sort((a, b) => {
    const t = a.occurredAt.getTime() - b.occurredAt.getTime();
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });

  const shifts: FoldedShift[] = [];
  const eventStatus = new Map<string, EventStatus>();
  let open: FoldedShift | null = null;

  for (const e of ordered) {
    if (e.type === 'clock_in') {
      if (!open) {
        open = {
          id: e.id,
          resortId: e.resortId,
          dutyType: e.dutyType ?? 'patrol',
          dutyNote: e.dutyNote ?? null,
          clockInAt: e.occurredAt,
          clockOutAt: null,
          status: 'open',
          closeReason: null,
          flagged: false,
          closeEventId: null,
        };
        shifts.push(open);
        eventStatus.set(e.id, 'applied');
      } else if (e.occurredAt.getTime() > open.clockInAt.getTime()) {
        // Clocked in somewhere else without clocking out: close the old one and flag it.
        open.clockOutAt = e.occurredAt;
        open.status = 'closed';
        open.closeReason = 'superseded';
        open.flagged = true;
        open = {
          id: e.id,
          resortId: e.resortId,
          dutyType: e.dutyType ?? 'patrol',
          dutyNote: e.dutyNote ?? null,
          clockInAt: e.occurredAt,
          clockOutAt: null,
          status: 'open',
          closeReason: null,
          flagged: false,
          closeEventId: null,
        };
        shifts.push(open);
        eventStatus.set(e.id, 'applied');
      } else {
        eventStatus.set(e.id, 'duplicate');
      }
      continue;
    }

    // clock_out
    if (!open) {
      eventStatus.set(e.id, 'orphan');
      continue;
    }
    if (e.occurredAt.getTime() < open.clockInAt.getTime()) {
      eventStatus.set(e.id, 'anomalous');
      continue;
    }
    open.clockOutAt = e.occurredAt;
    open.status = 'closed';
    open.closeReason =
      e.source === 'device_auto' ? 'auto' : e.source === 'admin' ? 'admin' : 'manual';
    // An admin close is deliberate, so it is never flagged for review; an automatic one
    // always is, because nobody confirmed the patroller actually left.
    open.flagged = open.closeReason === 'auto';
    open.closeEventId = e.id;
    eventStatus.set(e.id, 'applied');
    open = null;
  }

  return { shifts, eventStatus };
}

export type StoredShift = Omit<FoldedShift, 'status'> & { status: string; deletedAt: Date | null };

export interface ShiftChanges {
  create: FoldedShift[];
  /** Changed, or coming back from a tombstone. */
  update: FoldedShift[];
  /** Ids the replay no longer produces and that are not already tombstones. */
  tombstone: string[];
}

const sameTime = (a: Date | null, b: Date | null) =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * What a replay changes (Plan 55 D5, D6). A shift is written only when something about it
 * moved, because `updatedAt` is the delta's watermark: rewriting every shift on every
 * event would send a patroller's whole history to every iPad each time they clock in.
 */
export function shiftChanges(stored: StoredShift[], folded: FoldedShift[]): ShiftChanges {
  const byId = new Map(stored.map((s) => [s.id, s]));
  const produced = new Set(folded.map((s) => s.id));
  const create: FoldedShift[] = [];
  const update: FoldedShift[] = [];

  for (const f of folded) {
    const s = byId.get(f.id);
    if (!s) {
      create.push(f);
      continue;
    }
    const same =
      s.deletedAt === null &&
      s.resortId === f.resortId &&
      s.dutyType === f.dutyType &&
      s.dutyNote === f.dutyNote &&
      sameTime(s.clockInAt, f.clockInAt) &&
      sameTime(s.clockOutAt, f.clockOutAt) &&
      s.status === f.status &&
      s.closeReason === f.closeReason &&
      s.flagged === f.flagged &&
      s.closeEventId === f.closeEventId;
    if (!same) update.push(f);
  }

  const tombstone = stored.filter((s) => !produced.has(s.id) && s.deletedAt === null).map((s) => s.id);
  return { create, update, tombstone };
}

/**
 * Writes an `admin` clock-out under a deterministic id, reviving it if an earlier reopen
 * set it aside (D2). Both admin closes (a correction and a deactivation) go through here,
 * so a second close of the same shift updates the first rather than colliding with it.
 */
export async function writeAdminClose(
  tx: Prisma.TransactionClient,
  data: {
    id: string;
    orgId: string;
    resortId: string;
    patrollerId: string;
    occurredAt: Date;
    statusNote: string;
  },
): Promise<void> {
  const fields = {
    occurredAt: data.occurredAt,
    source: 'admin',
    status: 'applied',
    statusNote: data.statusNote,
  };
  await tx.timeClockEvent.upsert({
    where: { id: data.id },
    update: fields,
    create: {
      id: data.id,
      orgId: data.orgId,
      resortId: data.resortId,
      patrollerId: data.patrollerId,
      type: 'clock_out',
      ...fields,
    },
  });
}

@Injectable()
export class TimeClockFoldService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Replays one patroller's log and makes `TimeClockShift` match it. Runs inside the
   * caller's transaction when one is supplied so a batch of events lands atomically, and
   * in one of its own otherwise: the row lock below means nothing outside one.
   */
  async recomputeForPatroller(
    orgId: string,
    patrollerId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!tx) {
      await this.prisma.$transaction((t) => this.recomputeForPatroller(orgId, patrollerId, t), {
        timeout: 20_000,
      });
      return;
    }

    // One replay per patroller at a time (D8). Two iPads syncing the same person at once
    // would otherwise each read the log before the other's insert and write a stale fold.
    await tx.$queryRaw`SELECT id FROM PatrollerProfile WHERE id = ${patrollerId} FOR UPDATE`;

    const events = await tx.timeClockEvent.findMany({
      where: { orgId, patrollerId, status: { notIn: [...UNFOLDED_STATUSES] } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        resortId: true,
        type: true,
        dutyType: true,
        dutyNote: true,
        source: true,
        occurredAt: true,
        status: true,
      },
    });

    const { shifts, eventStatus } = foldEvents(events);

    const stored = await tx.timeClockShift.findMany({
      where: { orgId, patrollerId },
      select: {
        id: true,
        resortId: true,
        dutyType: true,
        dutyNote: true,
        clockInAt: true,
        clockOutAt: true,
        status: true,
        closeReason: true,
        flagged: true,
        closeEventId: true,
        deletedAt: true,
      },
    });
    const changes = shiftChanges(stored, shifts);

    if (changes.tombstone.length) {
      await tx.timeClockShift.updateMany({
        where: { id: { in: changes.tombstone } },
        data: { deletedAt: new Date() },
      });
    }
    const row = (s: FoldedShift) => ({
      resortId: s.resortId,
      dutyType: s.dutyType,
      dutyNote: s.dutyNote,
      clockInAt: s.clockInAt,
      clockOutAt: s.clockOutAt,
      status: s.status,
      closeReason: s.closeReason,
      flagged: s.flagged,
      closeEventId: s.closeEventId,
      deletedAt: null,
    });
    if (changes.create.length) {
      await tx.timeClockShift.createMany({
        data: changes.create.map((s) => ({ id: s.id, orgId, patrollerId, ...row(s) })),
      });
    }
    for (const s of changes.update) {
      await tx.timeClockShift.update({ where: { id: s.id }, data: row(s) });
    }

    // Record how each event was interpreted so the web UI can show orphans and anomalies,
    // writing only the ones whose reading changed: one statement per status, not per event.
    const was = new Map(events.map((e) => [e.id, e.status]));
    const moved = new Map<EventStatus, string[]>();
    for (const [eventId, status] of eventStatus) {
      if (was.get(eventId) === status) continue;
      moved.set(status, [...(moved.get(status) ?? []), eventId]);
    }
    for (const [status, ids] of moved) {
      await tx.timeClockEvent.updateMany({ where: { id: { in: ids } }, data: { status } });
    }
  }
}
