import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Folds a patroller's clock events into entries (§5.5, Plan 59 §3).
 *
 * The server never folds incrementally: whenever events land it replays that patroller's
 * whole log in order, so the outcome is independent of arrival order. An iPad offline all
 * day can deliver a morning clock-in after another source has already delivered the
 * afternoon, and the result still converges.
 */

type FoldEvent = {
  id: string;
  resortId: string;
  type: string;
  dutyType: string | null;
  dutyNote: string | null;
  source: string;
  occurredAt: Date;
  /** The shift a clock-out names; on a kept duplicate, the shift it belongs to. */
  entryId?: string | null;
  /** A server sweep's sweep moment, where it is placed (R4). */
  sweepAt?: Date | null;
  /** Only `voided` matters here: a kept duplicate, which is an alias and nothing more. */
  status?: string;
  statusNote?: string | null;
};

export type FoldedEntry = {
  id: string;
  resortId: string;
  dutyType: string;
  dutyNote: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  status: 'open' | 'closed';
  closeReason: string | null;
  flagged: boolean;
  /** The clock-out that closed it (Plan 55 D1); null while open. */
  closeEventId: string | null;
};

export type EventStatus = 'applied' | 'duplicate' | 'orphan' | 'anomalous' | 'rejected' | 'voided';

/** Statuses the fold never reads: refused on arrival, or set aside by an admin (D2). */
export const UNFOLDED_STATUSES = ['rejected', 'voided'] as const;

/** Notes the server writes on events (Plan 59 §2). */
export const NOTE = {
  /** A duplicate clock-in a staff edit set aside, so the replay can't make it a shift (E26). */
  keptDuplicate: 'kept_duplicate',
  /** An iPad's own auto clock-out: only the server sweeps (R5). */
  serverSweeps: 'server_sweeps',
  /** A clock-in from someone inactive or removed, accepted because it was real (R9). */
  inactivePatroller: 'inactive_patroller',
  /** A patroller's clock-out at a time she chose (R6). */
  chosenTime: 'chosen_time',
} as const;

export interface FoldResult {
  entries: FoldedEntry[];
  eventStatus: Map<string, EventStatus>;
  /** Each duplicate clock-in and the shift it folded into, recorded as its `entryId`. */
  duplicateOf: Map<string, string>;
}

/** Where the replay places an event: a server sweep at its sweep moment (R4). */
const placedAt = (e: FoldEvent) => (e.source === 'auto' && e.sweepAt ? e.sweepAt : e.occurredAt);

/** Pure replay of Plan 59 §3. Exported for unit tests and the shared vectors. */
export function foldEvents(events: FoldEvent[]): FoldResult {
  const entries: FoldedEntry[] = [];
  const eventStatus = new Map<string, EventStatus>();
  const duplicateOf = new Map<string, string>();
  // A duplicate clock-in's id, and the shift it folded into (R3).
  const alias = new Map<string, string>();

  const live: FoldEvent[] = [];
  for (const e of events) {
    if (e.status === 'voided') {
      if (e.type === 'clock_in' && e.entryId) alias.set(e.id, e.entryId);
    } else {
      live.push(e);
    }
  }
  live.sort((a, b) => {
    const t = placedAt(a).getTime() - placedAt(b).getTime();
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });

  let open: FoldedEntry | null = null;
  for (const e of live) {
    if (e.type === 'clock_in') {
      if (open) {
        eventStatus.set(e.id, 'duplicate');
        alias.set(e.id, open.id);
        duplicateOf.set(e.id, open.id);
        continue;
      }
      open = {
        id: e.id,
        resortId: e.resortId,
        dutyType: e.dutyType ?? 'patrol',
        dutyNote: e.dutyNote ?? null,
        clockInAt: e.occurredAt,
        clockOutAt: null,
        status: 'open',
        closeReason: null,
        flagged: e.statusNote === NOTE.inactivePatroller,
        closeEventId: null,
      };
      entries.push(open);
      eventStatus.set(e.id, 'applied');
      continue;
    }

    // A clock-out. Only the server sweeps (R5), and it closes only the shift it names (R3).
    // A row written before Plan 59 names nothing, and closes whatever is open.
    const named = e.entryId ? (alias.get(e.entryId) ?? e.entryId) : open?.id;
    if (e.source === 'device_auto' || !open || named !== open.id) {
      eventStatus.set(e.id, 'orphan');
      continue;
    }
    open.clockOutAt = e.occurredAt;
    open.status = 'closed';
    open.closeReason = e.source === 'auto' ? 'auto' : e.source === 'admin' ? 'admin' : 'manual';
    // An admin close is deliberate, so it is never flagged for review; an automatic one
    // always is, because nobody confirmed the patroller actually left.
    open.flagged = open.closeReason === 'auto' || (open.flagged && open.closeReason !== 'admin');
    open.closeEventId = e.id;
    eventStatus.set(e.id, 'applied');
    open = null;
  }

  return { entries, eventStatus, duplicateOf };
}

export type StoredEntry = Omit<FoldedEntry, 'status'> & { status: string; deletedAt: Date | null };

export interface EntryChanges {
  create: FoldedEntry[];
  /** Changed, or coming back from a tombstone. */
  update: FoldedEntry[];
  /** Ids the replay no longer produces and that are not already tombstones. */
  tombstone: string[];
}

const sameTime = (a: Date | null, b: Date | null) =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * What a replay changes (Plan 55 D5, D6). An entry is written only when something about it
 * moved, because `updatedAt` is the delta's watermark: rewriting every entry on every
 * event would send a patroller's whole history to every iPad each time they clock in.
 */
export function entryChanges(stored: StoredEntry[], folded: FoldedEntry[]): EntryChanges {
  const byId = new Map(stored.map((s) => [s.id, s]));
  const produced = new Set(folded.map((s) => s.id));
  const create: FoldedEntry[] = [];
  const update: FoldedEntry[] = [];

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
 * so a second close of the same entry updates the first rather than colliding with it.
 */
export async function writeAdminClose(
  tx: Prisma.TransactionClient,
  data: {
    id: string;
    orgId: string;
    resortId: string;
    patrollerId: string;
    entryId: string;
    occurredAt: Date;
    statusNote: string;
  },
): Promise<void> {
  const fields = {
    occurredAt: data.occurredAt,
    entryId: data.entryId,
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
   * Replays one patroller's log and makes `TimeEntry` match it. Runs inside the
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
      where: {
        orgId,
        patrollerId,
        OR: [
          { status: { notIn: [...UNFOLDED_STATUSES] } },
          // A kept duplicate still names its shift (E26).
          { status: 'voided', type: 'clock_in', statusNote: NOTE.keptDuplicate },
        ],
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        entryId: true,
        sweepAt: true,
        statusNote: true,
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

    const { entries, eventStatus, duplicateOf } = foldEvents(events);

    const stored = await tx.timeEntry.findMany({
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
    const changes = entryChanges(stored, entries);

    if (changes.tombstone.length) {
      await tx.timeEntry.updateMany({
        where: { id: { in: changes.tombstone } },
        data: { deletedAt: new Date() },
      });
    }
    const row = (s: FoldedEntry) => ({
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
      await tx.timeEntry.createMany({
        data: changes.create.map((s) => ({ id: s.id, orgId, patrollerId, ...row(s) })),
      });
    }
    for (const s of changes.update) {
      await tx.timeEntry.update({ where: { id: s.id }, data: row(s) });
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
    // A duplicate remembers its shift, so a staff edit of that shift can keep it (E26).
    const shiftOf = new Map(events.map((e) => [e.id, e.entryId]));
    for (const [eventId, entryId] of duplicateOf) {
      if (shiftOf.get(eventId) !== entryId) {
        await tx.timeClockEvent.update({ where: { id: eventId }, data: { entryId } });
      }
    }
  }
}
