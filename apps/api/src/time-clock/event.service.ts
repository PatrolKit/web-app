import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TimeClockFoldService } from './fold.service';
import { isUniqueViolation } from '../common/util/prisma-errors';
import type { ClockEventInput, EventResult } from '../contracts/time-clock.contracts';

/** Anything dated further ahead than this is a broken device clock, not an entry (§5.7). */
const FUTURE_TOLERANCE_MS = 24 * 3600_000;

/** What a device may say about where an event came from. `admin` is the server's (D3). */
const DEVICE_SOURCES = new Set(['device', 'device_auto']);

type StoredResult = { id: string; orgId: string; status: string; statusNote: string | null };

@Injectable()
export class TimeClockEventService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foldService: TimeClockFoldService,
  ) {}

  /**
   * Batch submit (§5.4). Events are idempotent by primary key, so a retry after an
   * ambiguous failure is free. One bad event never fails the batch — every event gets
   * its own result, in the order sent.
   *
   * `deviceId` is the authenticated device's, always (Plan 55 D3): an event's own claim
   * to have come from somewhere else is ignored.
   */
  async submit(
    orgId: string,
    deviceId: string,
    events: ClockEventInput[],
  ): Promise<{ results: EventResult[] }> {
    const results = new Map<string, EventResult>();
    const affected = new Set<string>();
    const accepted: string[] = [];

    const [resorts, patrollers, device, stored] = await Promise.all([
      this.prisma.resort.findMany({ where: { orgId }, select: { id: true } }),
      this.prisma.patrollerProfile.findMany({ where: { membership: { orgId } }, select: { id: true } }),
      this.prisma.device.findUnique({ where: { id: deviceId }, select: { resortId: true } }),
      this.prisma.timeClockEvent.findMany({
        where: { id: { in: events.map((e) => e.id) } },
        select: { id: true, orgId: true, status: true, statusNote: true },
      }),
    ]);
    const resortIds = new Set(resorts.map((r) => r.id));
    const patrollerIds = new Set(patrollers.map((p) => p.id));
    const held = new Map(stored.map((s) => [s.id, s]));
    // Where the terminal stood on arrival (D4): recorded, never enforced.
    const deviceResortId = device?.resortId ?? null;

    const now = Date.now();

    for (const event of events) {
      if (results.has(event.id)) continue; // the same id twice in one batch

      // A retry of something already held. Report where it landed; never re-apply.
      const existing = held.get(event.id);
      if (existing) {
        results.set(event.id, this.reportHeld(orgId, existing));
        continue;
      }
      if (!DEVICE_SOURCES.has(event.source)) {
        results.set(event.id, { id: event.id, status: 'rejected', note: 'source_not_allowed' });
        continue;
      }
      if (!resortIds.has(event.resortId)) {
        results.set(event.id, { id: event.id, status: 'rejected', note: 'unknown_resort' });
        continue;
      }
      if (!patrollerIds.has(event.patrollerId)) {
        results.set(event.id, { id: event.id, status: 'rejected', note: 'unknown_patroller' });
        continue;
      }

      const occurredAt = new Date(event.occurredAt);
      const implausible = occurredAt.getTime() > now + FUTURE_TOLERANCE_MS;
      try {
        // Implausible events are kept, not dropped, so an admin can see the bad clock.
        await this.prisma.timeClockEvent.create({
          data: {
            id: event.id,
            orgId,
            resortId: event.resortId,
            patrollerId: event.patrollerId,
            deviceId,
            deviceResortId,
            type: event.type,
            dutyType: event.dutyType ?? null,
            dutyNote: event.dutyNote ?? null,
            source: event.source,
            occurredAt,
            clockSkewMs: event.clockSkewMs ?? null,
            ...(implausible ? { status: 'rejected', statusNote: 'clock_implausible' } : {}),
          },
        });
      } catch (err) {
        // Another terminal, or this one's own retry, landed it first (D8). The row exists,
        // which is what was asked for; report it once the folds below have run.
        if (!isUniqueViolation(err)) throw err;
        accepted.push(event.id);
        continue;
      }
      if (implausible) {
        results.set(event.id, { id: event.id, status: 'rejected', note: 'clock_implausible' });
        continue;
      }
      accepted.push(event.id);
      affected.add(event.patrollerId);
    }

    // Recompute per patroller, each in its own transaction (§5.5).
    for (const patrollerId of affected) {
      await this.foldService.recomputeForPatroller(orgId, patrollerId);
    }

    // Report the status the fold actually assigned to the newly accepted events.
    if (accepted.length) {
      const folded = await this.prisma.timeClockEvent.findMany({
        where: { id: { in: accepted } },
        select: { id: true, orgId: true, status: true, statusNote: true },
      });
      for (const row of folded) results.set(row.id, this.reportHeld(orgId, row));
    }

    return {
      results: [...new Set(events.map((e) => e.id))].map(
        (id) => results.get(id) ?? { id, status: 'applied', note: null },
      ),
    };
  }

  /**
   * An id is global, and an event already held under it in another org is not this
   * device's to learn about: refused, without saying where it was seen.
   */
  private reportHeld(orgId: string, row: StoredResult): EventResult {
    if (row.orgId !== orgId) return { id: row.id, status: 'rejected', note: 'id_conflict' };
    return { id: row.id, status: row.status as EventResult['status'], note: row.statusNote };
  }
}
