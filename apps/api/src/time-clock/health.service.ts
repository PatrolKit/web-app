import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { displayName } from '../common/util/person';
import { sweepAt } from './sweep.util';
import type { TimeClockHealthResponse } from '../contracts/time-clock.contracts';

/** How far back Health looks. A season's problems are found in days, not months. */
const WINDOW_MS = 30 * 24 * 3600_000;
/** Enough to see a pattern; a terminal sending thousands of bad events is one problem. */
const LIMIT = 200;
/** What the fold did not apply. `duplicate` is a double tap, and harmless. */
const UNAPPLIED = ['rejected', 'orphan', 'anomalous', 'voided'];

const EVENT_INCLUDE = {
  resort: { select: { name: true } },
  patroller: { include: { membership: { select: { user: true } } } },
} as const;

@Injectable()
export class TimeClockHealthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Time Tracking → Health (Plan 55 D13): what the server refused or could not place,
   * every terminal and when it last called in, events from a terminal bound somewhere
   * else (D4), and how many shifts no device closed.
   *
   * Terminals are read from `Device`, not from events, so one that has gone quiet still
   * shows — which is the case this exists to catch.
   */
  async get(orgId: string): Promise<TimeClockHealthResponse> {
    const since = new Date(Date.now() - WINDOW_MS);
    const [unapplied, candidates, terminals, resorts, open, settings] = await Promise.all([
      this.prisma.timeClockEvent.findMany({
        where: { orgId, status: { in: UNAPPLIED }, recordedAt: { gte: since } },
        include: EVENT_INCLUDE,
        orderBy: { recordedAt: 'desc' },
        take: LIMIT,
      }),
      // `deviceResortId <> resortId` compares two columns, which Prisma's where cannot;
      // the set with a binding at all is small enough to compare here.
      this.prisma.timeClockEvent.findMany({
        where: { orgId, deviceResortId: { not: null }, recordedAt: { gte: since } },
        include: EVENT_INCLUDE,
        orderBy: { recordedAt: 'desc' },
      }),
      this.prisma.device.findMany({
        where: { orgId, role: 'time_clock.terminal' },
        include: { resort: { select: { name: true } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.resort.findMany({ where: { orgId }, select: { id: true, name: true } }),
      this.prisma.timeClockShift.findMany({
        where: { orgId, status: 'open', deletedAt: null },
        select: { clockInAt: true, resort: { select: { timeZone: true } } },
      }),
      this.prisma.timeClockSettings.findUnique({ where: { orgId } }),
    ]);

    const mismatches = candidates.filter((e) => e.deviceResortId !== e.resortId).slice(0, LIMIT);
    const resortName = new Map(resorts.map((r) => [r.id, r.name]));
    const deviceIds = [...new Set([...unapplied, ...mismatches].map((e) => e.deviceId).filter((d): d is string => !!d))];
    const devices = await this.prisma.device.findMany({
      where: { id: { in: deviceIds } },
      select: { id: true, name: true },
    });
    const deviceName = new Map(devices.map((d) => [d.id, d.name]));
    const nameOf = (e: (typeof unapplied)[number]) => ({
      patrollerName: e.patroller ? displayName(e.patroller.membership.user) : null,
      resortName: e.resort?.name ?? null,
      deviceName: e.deviceId ? deviceName.get(e.deviceId) ?? null : null,
    });

    const localTime = settings?.autoCloseLocalTime ?? '03:00';
    const now = Date.now();

    return {
      unapplied: unapplied.map((e) => ({
        id: e.id,
        type: e.type,
        status: e.status,
        statusNote: e.statusNote,
        occurredAt: e.occurredAt.toISOString(),
        recordedAt: e.recordedAt.toISOString(),
        ...nameOf(e),
      })),
      terminals: terminals.map((d) => ({
        id: d.id,
        name: d.name,
        resortName: d.resort?.name ?? null,
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        appVersion: d.appVersion ? `${d.appVersion}${d.appBuild ? ` (${d.appBuild})` : ''}` : null,
      })),
      mismatches: mismatches.map((e) => ({
        id: e.id,
        type: e.type,
        occurredAt: e.occurredAt.toISOString(),
        ...nameOf(e),
        boundResortName: e.deviceResortId ? resortName.get(e.deviceResortId) ?? null : null,
      })),
      stillOpenPastSweep: open.filter(
        (s) => sweepAt(s.clockInAt, s.resort.timeZone, localTime).getTime() < now,
      ).length,
    };
  }
}
