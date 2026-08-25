import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TimeClockFoldService } from './fold.service';
import type { ClockEventInput, EventResult } from '../contracts/time-clock.contracts';

/** Anything dated further ahead than this is a broken device clock, not a shift (§5.7). */
const FUTURE_TOLERANCE_MS = 24 * 3600_000;

@Injectable()
export class TimeClockEventService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foldService: TimeClockFoldService,
  ) {}

  /**
   * Batch submit (§5.4). Events are idempotent by primary key, so a retry after an
   * ambiguous failure is free. One bad event never fails the batch — every event gets
   * its own result.
   */
  async submit(
    orgId: string,
    deviceId: string | null,
    events: ClockEventInput[],
  ): Promise<{ results: EventResult[] }> {
    const results: EventResult[] = [];
    const affected = new Set<string>();

    const [resorts, patrollers] = await Promise.all([
      this.prisma.resort.findMany({ where: { orgId }, select: { id: true } }),
      this.prisma.patrollerProfile.findMany({ where: { membership: { orgId } }, select: { id: true } }),
    ]);
    const resortIds = new Set(resorts.map((r) => r.id));
    const patrollerIds = new Set(patrollers.map((p) => p.id));

    const now = Date.now();

    for (const event of events) {
      if (!resortIds.has(event.resortId)) {
        results.push({ id: event.id, status: 'rejected', note: 'unknown_resort' });
        continue;
      }
      if (!patrollerIds.has(event.patrollerId)) {
        results.push({ id: event.id, status: 'rejected', note: 'unknown_patroller' });
        continue;
      }

      const occurredAt = new Date(event.occurredAt);
      if (occurredAt.getTime() > now + FUTURE_TOLERANCE_MS) {
        results.push({ id: event.id, status: 'rejected', note: 'clock_implausible' });
        await this.recordRejected(orgId, deviceId, event, occurredAt, 'clock_implausible');
        continue;
      }

      const existing = await this.prisma.timeClockEvent.findUnique({
        where: { id: event.id },
        select: { id: true, status: true, statusNote: true },
      });
      if (existing) {
        // A retry of something already folded. Report where it landed; never re-apply.
        results.push({
          id: existing.id,
          status: existing.status as EventResult['status'],
          note: existing.statusNote,
        });
        continue;
      }

      await this.prisma.timeClockEvent.create({
        data: {
          id: event.id,
          orgId,
          resortId: event.resortId,
          patrollerId: event.patrollerId,
          deviceId: event.deviceId ?? deviceId,
          type: event.type,
          dutyType: event.dutyType ?? null,
          dutyNote: event.dutyNote ?? null,
          source: event.source,
          occurredAt,
          clockSkewMs: event.clockSkewMs ?? null,
        },
      });
      affected.add(event.patrollerId);
    }

    // Recompute per patroller, each in its own transaction (§5.5).
    for (const patrollerId of affected) {
      await this.prisma.$transaction(
        async (tx) => this.foldService.recomputeForPatroller(orgId, patrollerId, tx),
        { timeout: 20_000 },
      );
    }

    // Report the status the fold actually assigned to the newly accepted events.
    const folded = await this.prisma.timeClockEvent.findMany({
      where: { id: { in: events.map((e) => e.id) } },
      select: { id: true, status: true, statusNote: true },
    });
    const byId = new Map(folded.map((f) => [f.id, f]));
    for (const event of events) {
      if (results.some((r) => r.id === event.id)) continue;
      const row = byId.get(event.id);
      results.push({
        id: event.id,
        status: (row?.status as EventResult['status']) ?? 'applied',
        note: row?.statusNote ?? null,
      });
    }

    return { results };
  }

  /** Implausible events are kept, not dropped, so an admin can see the bad clock. */
  private async recordRejected(
    orgId: string,
    deviceId: string | null,
    event: ClockEventInput,
    occurredAt: Date,
    note: string,
  ): Promise<void> {
    await this.prisma.timeClockEvent.upsert({
      where: { id: event.id },
      update: {},
      create: {
        id: event.id,
        orgId,
        resortId: event.resortId,
        patrollerId: event.patrollerId,
        deviceId: event.deviceId ?? deviceId,
        type: event.type,
        dutyType: event.dutyType ?? null,
        dutyNote: event.dutyNote ?? null,
        source: event.source,
        occurredAt,
        clockSkewMs: event.clockSkewMs ?? null,
        status: 'rejected',
        statusNote: note,
      },
    });
  }
}
