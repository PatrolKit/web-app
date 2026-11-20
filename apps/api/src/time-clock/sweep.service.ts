import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from '../common/util/prisma-errors';
import { TimeClockFoldService } from './fold.service';
import { autoClockOutAt, sweepAt } from './sweep.util';

/** Soon after startup, so a sweep missed while the server was down runs at once (E2). */
const FIRST_SWEEP_MS = 10_000;
const SWEEP_EVERY_MS = 5 * 60_000;

/**
 * Only the server sweeps (Plan 59 R5). Every shift still open at its sweep moment gets an
 * auto clock-out at min(clock-in + window, sweep), under the policy in force now (E14). A
 * reopened shift is open like any other, so it is swept again, with the next id (E11).
 *
 * The routes a patroller or staff use call `sweep` for that patroller first, so nothing
 * of theirs reaches the log ahead of a sweep that is due (E12).
 */
@Injectable()
export class TimeClockSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimeClockSweepService.name);
  private timers: NodeJS.Timeout[] = [];
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly foldService: TimeClockFoldService,
  ) {}

  onModuleInit(): void {
    this.timers = [setTimeout(() => void this.sweepAll(), FIRST_SWEEP_MS), setInterval(() => void this.sweepAll(), SWEEP_EVERY_MS)];
    // Never the reason a process stays up.
    for (const t of this.timers) t.unref();
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  /** The scheduled run, one at a time. Failures are logged; the next run tries again. */
  async sweepAll(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const swept = await this.sweep({});
      if (swept) this.logger.log({ swept }, 'Time clock shifts swept');
    } catch (err) {
      this.logger.error({ err }, 'Time clock sweep failed');
    } finally {
      this.sweeping = false;
    }
  }

  /** Sweeps every due shift in scope, and says how many it closed. */
  async sweep(scope: { orgId?: string; patrollerId?: string }, now = new Date()): Promise<number> {
    const open = await this.prisma.timeEntry.findMany({
      where: {
        status: 'open',
        deletedAt: null,
        ...(scope.orgId ? { orgId: scope.orgId } : {}),
        ...(scope.patrollerId ? { patrollerId: scope.patrollerId } : {}),
      },
      select: { id: true, orgId: true, resortId: true, patrollerId: true, clockInAt: true, resort: { select: { timeZone: true } } },
    });
    if (!open.length) return 0;

    const orgIds = [...new Set(open.map((e) => e.orgId))];
    const settings = await this.prisma.timeClockSettings.findMany({ where: { orgId: { in: orgIds } } });
    const policy = new Map(settings.map((s) => [s.orgId, s]));

    let swept = 0;
    for (const entry of open) {
      const p = policy.get(entry.orgId);
      const localTime = p?.autoCloseLocalTime ?? '03:00';
      const hours = p?.autoCloseAfterHours ?? 4;
      const moment = sweepAt(entry.clockInAt, entry.resort.timeZone, localTime);
      if (moment.getTime() > now.getTime()) continue;

      const earlier = await this.prisma.timeClockEvent.count({ where: { id: { startsWith: `sweep:${entry.id}:` } } });
      try {
        await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.timeClockEvent.create({
            data: {
              id: `sweep:${entry.id}:${earlier + 1}`,
              orgId: entry.orgId,
              resortId: entry.resortId,
              patrollerId: entry.patrollerId,
              type: 'clock_out',
              source: 'auto',
              occurredAt: autoClockOutAt(entry.clockInAt, entry.resort.timeZone, localTime, hours),
              sweepAt: moment,
              entryId: entry.id,
            },
          });
          await this.foldService.recomputeForPatroller(entry.orgId, entry.patrollerId, tx);
        }, { timeout: 20_000 });
        swept++;
      } catch (err) {
        // Another run swept it first; the row it wrote is the answer.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return swept;
  }
}
