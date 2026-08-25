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

type FoldedShift = {
  id: string;
  resortId: string;
  dutyType: string;
  dutyNote: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  status: 'open' | 'closed';
  closeReason: string | null;
  flagged: boolean;
};

export type EventStatus = 'applied' | 'duplicate' | 'orphan' | 'anomalous' | 'rejected';

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
    eventStatus.set(e.id, 'applied');
    open = null;
  }

  return { shifts, eventStatus };
}

@Injectable()
export class TimeClockFoldService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Replays one patroller's log and makes `TimeClockShift` match it. Runs inside the
   * caller's transaction when one is supplied so a batch of events lands atomically.
   */
  async recomputeForPatroller(
    orgId: string,
    patrollerId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;

    const events = await db.timeClockEvent.findMany({
      where: { orgId, patrollerId, status: { not: 'rejected' } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        resortId: true,
        type: true,
        dutyType: true,
        dutyNote: true,
        source: true,
        occurredAt: true,
      },
    });

    const { shifts, eventStatus } = foldEvents(events);

    const existing = await db.timeClockShift.findMany({
      where: { orgId, patrollerId },
      select: { id: true },
    });
    const keep = new Set(shifts.map((s) => s.id));
    const orphanedShiftIds = existing.map((s) => s.id).filter((id) => !keep.has(id));
    if (orphanedShiftIds.length) {
      await db.timeClockShift.deleteMany({ where: { id: { in: orphanedShiftIds } } });
    }

    for (const s of shifts) {
      const data = {
        orgId,
        resortId: s.resortId,
        patrollerId,
        dutyType: s.dutyType,
        dutyNote: s.dutyNote,
        clockInAt: s.clockInAt,
        clockOutAt: s.clockOutAt,
        status: s.status,
        closeReason: s.closeReason,
        flagged: s.flagged,
      };
      await db.timeClockShift.upsert({
        where: { id: s.id },
        update: data,
        create: { id: s.id, ...data },
      });
    }

    // Record how each event was interpreted so the web UI can show orphans and anomalies.
    for (const [eventId, status] of eventStatus) {
      await db.timeClockEvent.update({ where: { id: eventId }, data: { status } });
    }
  }
}
