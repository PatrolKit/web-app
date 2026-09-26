import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CRASH_RESETS } from './telemetry-report';
import {
  DEFAULT_INTERVAL_S, MAX_INTERVAL_S, MIN_INTERVAL_S, OFFLINE_AFTER_MS, OFFLINE_AFTER_UNBOUND_MS,
} from './telemetry.service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const TELEMETRY_RANGES = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY } as const;
export type TelemetryRange = keyof typeof TELEMETRY_RANGES;

/** Points in a memory chart, however long the range. */
const CHART_BUCKETS = 240;

const BRIDGE_ROLE = 'ski_swap.print_bridge';

export interface BridgeIdentity {
  id: string;
  name: string;
  clientId: string;
  org: { id: string; name: string };
  station: string | null;
  lastSeenAt: string | null;
  online: boolean;
}

export interface BridgeLatest {
  receivedAt: string;
  firmwareVersion: string | null;
  board: string | null;
  psram: boolean | null;
  bootCount: number | null;
  resetReason: string | null;
  bootAt: string | null;
  memFree: number | null;
  memLargestBlock: number | null;
  memMinFreeEver: number | null;
  wifiRssi: number | null;
  printerLink: string | null;
}

/** What happened to one bridge in a range. */
export interface BridgeTotals {
  reboots: number;
  /** Crashes and power faults: the reboots nobody asked for. */
  unplannedReboots: number;
  outages: number;
  disconnectedMs: number;
  /** The lowest `minFreeEver` any report in the range carried. */
  lowestMemory: number | null;
  reports: number;
}

export interface BridgeSummaryRow extends BridgeIdentity, BridgeTotals {
  latest: BridgeLatest | null;
}

export interface FleetSummary {
  range: TelemetryRange;
  generatedAt: string;
  totals: {
    bridges: number;
    online: number;
    reporting: number;
    reboots: number;
    unplannedReboots: number;
    disconnectedMs: number;
    lowestMemory: number | null;
  };
  /** Firmware versions by how many bridges last reported each. */
  firmware: { version: string; bridges: number }[];
  /** Why bridges rebooted in the range, most common first. */
  resetReasons: { reason: string; reboots: number; unplanned: boolean }[];
  bridges: BridgeSummaryRow[];
}

export interface BridgeHistory {
  range: TelemetryRange;
  generatedAt: string;
  bridge: BridgeIdentity & { intervalS: number; intervalIsDefault: boolean };
  latest: (BridgeLatest & { body: unknown; malformedFields: unknown }) | null;
  totals: BridgeTotals;
  /** Memory over the range, the lowest in each bucket; null where nothing was reported. */
  memory: {
    bucketMs: number;
    points: { at: string; free: number | null; minFreeEver: number | null; largestBlock: number | null }[];
  };
  reboots: { at: string; reason: string | null; unplanned: boolean; crash: boolean; bootCount: number | null; missed: number; firmwareVersion: string | null }[];
  outages: { startedAt: string; endedAt: string | null; ms: number }[];
}

/**
 * The Device Telemetry tab's data, for print bridges.
 *
 * Every figure is read over a range. Reboots are counted by when they happened
 * (`bootAt`), not by when the report saying so arrived, so a bridge whose first
 * report comes days after it booted does not count that boot in today's range.
 * Disconnected time is outages clipped to the range, plus one still going.
 */
@Injectable()
export class TelemetryAdminService {
  constructor(private readonly prisma: PrismaService) {}

  parseRange(value: string | undefined): TelemetryRange {
    const range = value ?? '7d';
    if (!Object.prototype.hasOwnProperty.call(TELEMETRY_RANGES, range)) {
      throw new BadRequestException(`range must be one of ${Object.keys(TELEMETRY_RANGES).join(', ')}`);
    }
    return range as TelemetryRange;
  }

  /** Every print bridge, for the picker. */
  async bridges(): Promise<BridgeIdentity[]> {
    return (await this.bridgeRows()).map((d) => this.identity(d, Date.now()));
  }

  async fleet(range: TelemetryRange): Promise<FleetSummary> {
    const now = Date.now();
    const since = new Date(now - TELEMETRY_RANGES[range]);
    const devices = await this.bridgeRows();
    const ids = devices.map((d) => d.id);

    const [reports, outages, latest] = await Promise.all([
      this.prisma.deviceTelemetry.findMany({
        where: { deviceId: { in: ids }, receivedAt: { gte: since } },
        select: {
          deviceId: true, bootAt: true, receivedAt: true, bootsSincePrevious: true,
          unplannedReboot: true, resetReason: true, memMinFreeEver: true,
        },
      }),
      this.prisma.deviceOutage.findMany({
        where: { deviceId: { in: ids }, endedAt: { gte: since } },
        select: { deviceId: true, startedAt: true, endedAt: true },
      }),
      this.latestFor(ids),
    ]);

    const rows = devices.map((d): BridgeSummaryRow => {
      const identity = this.identity(d, now);
      return {
        ...identity,
        ...this.totals(
          reports.filter((r) => r.deviceId === d.id),
          outages.filter((o) => o.deviceId === d.id),
          this.ongoing(identity, now),
          since.getTime(),
          now,
        ),
        latest: latest.get(d.id) ?? null,
      };
    });

    const firmware = new Map<string, number>();
    for (const row of rows) {
      const version = row.latest?.firmwareVersion;
      if (version) firmware.set(version, (firmware.get(version) ?? 0) + 1);
    }
    const reasons = new Map<string, { reboots: number; unplanned: boolean }>();
    for (const r of reports) {
      if (r.bootsSincePrevious === 0 || !this.inRange(r, since.getTime())) continue;
      const reason = r.resetReason ?? 'unknown';
      const entry = reasons.get(reason) ?? { reboots: 0, unplanned: r.unplannedReboot };
      entry.reboots += r.bootsSincePrevious;
      reasons.set(reason, entry);
    }

    const lows = rows.map((r) => r.lowestMemory).filter((m): m is number => m !== null);
    return {
      range,
      generatedAt: new Date(now).toISOString(),
      totals: {
        bridges: rows.length,
        online: rows.filter((r) => r.online).length,
        reporting: rows.filter((r) => r.reports > 0).length,
        reboots: sum(rows.map((r) => r.reboots)),
        unplannedReboots: sum(rows.map((r) => r.unplannedReboots)),
        disconnectedMs: sum(rows.map((r) => r.disconnectedMs)),
        lowestMemory: lows.length ? Math.min(...lows) : null,
      },
      firmware: [...firmware].map(([version, bridges]) => ({ version, bridges })).sort((a, b) => b.bridges - a.bridges),
      resetReasons: [...reasons].map(([reason, e]) => ({ reason, ...e })).sort((a, b) => b.reboots - a.reboots),
      bridges: rows,
    };
  }

  async history(deviceId: string, range: TelemetryRange): Promise<BridgeHistory> {
    const now = Date.now();
    const since = new Date(now - TELEMETRY_RANGES[range]);
    const device = (await this.bridgeRows(deviceId))[0];
    if (!device) throw new NotFoundException('No such print bridge');

    const [reports, outages, latestRow] = await Promise.all([
      this.prisma.deviceTelemetry.findMany({
        where: { deviceId, receivedAt: { gte: since } },
        orderBy: { receivedAt: 'asc' },
        select: {
          receivedAt: true, bootAt: true, bootCount: true, bootsSincePrevious: true, unplannedReboot: true,
          resetReason: true, firmwareVersion: true, memFree: true, memMinFreeEver: true, memLargestBlock: true,
        },
      }),
      this.prisma.deviceOutage.findMany({
        where: { deviceId, endedAt: { gte: since } },
        orderBy: { startedAt: 'asc' },
        select: { startedAt: true, endedAt: true },
      }),
      this.prisma.deviceTelemetry.findFirst({ where: { deviceId }, orderBy: { receivedAt: 'desc' } }),
    ]);

    const identity = this.identity(device, now);
    const ongoing = this.ongoing(identity, now);

    // The lowest of each figure in each bucket: for memory, the low is the news.
    //
    // Whole hours once a bucket is longer than half of one. Memory dips on the
    // bridge's hourly TLS handshake, and a 42-minute bucket catches that dip in
    // some buckets and not others, which draws a sawtooth that is only an
    // artifact of the bucket size.
    const raw = Math.max(60_000, Math.ceil(TELEMETRY_RANGES[range] / CHART_BUCKETS));
    const bucketMs = raw > HOUR / 2 ? Math.ceil(raw / HOUR) * HOUR : raw;
    const start = Math.floor(since.getTime() / bucketMs) * bucketMs;
    const buckets = new Map<number, { free: number | null; minFreeEver: number | null; largestBlock: number | null }>();
    for (let at = start; at <= now; at += bucketMs) buckets.set(at, { free: null, minFreeEver: null, largestBlock: null });
    for (const r of reports) {
      const bucket = buckets.get(Math.floor(r.receivedAt.getTime() / bucketMs) * bucketMs);
      if (!bucket) continue;
      bucket.free = lowest(bucket.free, r.memFree);
      bucket.minFreeEver = lowest(bucket.minFreeEver, r.memMinFreeEver);
      bucket.largestBlock = lowest(bucket.largestBlock, r.memLargestBlock);
    }

    return {
      range,
      generatedAt: new Date(now).toISOString(),
      bridge: {
        ...identity,
        intervalS: device.telemetryIntervalS ?? DEFAULT_INTERVAL_S,
        intervalIsDefault: device.telemetryIntervalS === null,
      },
      latest: latestRow
        ? {
            ...this.latestOf(latestRow),
            body: latestRow.body,
            malformedFields: latestRow.malformedFields,
          }
        : null,
      totals: this.totals(reports, outages, ongoing, since.getTime(), now),
      memory: {
        bucketMs,
        points: [...buckets].map(([at, b]) => ({ at: new Date(at).toISOString(), ...b })),
      },
      reboots: reports
        .filter((r) => r.bootsSincePrevious > 0 && this.inRange(r, since.getTime()))
        .map((r) => ({
          at: (r.bootAt ?? r.receivedAt).toISOString(),
          reason: r.resetReason,
          unplanned: r.unplannedReboot,
          crash: r.resetReason !== null && CRASH_RESETS.has(r.resetReason),
          bootCount: r.bootCount,
          missed: r.bootsSincePrevious - 1,
          firmwareVersion: r.firmwareVersion,
        }))
        .reverse(),
      outages: [
        ...(ongoing ? [{ startedAt: ongoing.toISOString(), endedAt: null, ms: now - ongoing.getTime() }] : []),
        ...outages
          .map((o) => ({
            startedAt: o.startedAt.toISOString(),
            endedAt: o.endedAt.toISOString(),
            ms: o.endedAt.getTime() - o.startedAt.getTime(),
          }))
          .reverse(),
      ],
    };
  }

  /** How often a bridge reports. Null goes back to the firmware's default. */
  async setInterval(deviceId: string, intervalS: number | null): Promise<{ intervalS: number }> {
    if (intervalS !== null && (!Number.isInteger(intervalS) || intervalS < MIN_INTERVAL_S || intervalS > MAX_INTERVAL_S)) {
      throw new BadRequestException(`intervalS must be a whole number from ${MIN_INTERVAL_S} to ${MAX_INTERVAL_S}, or null`);
    }
    const device = (await this.bridgeRows(deviceId))[0];
    if (!device) throw new NotFoundException('No such print bridge');
    await this.prisma.device.update({ where: { id: deviceId }, data: { telemetryIntervalS: intervalS } });
    return { intervalS: intervalS ?? DEFAULT_INTERVAL_S };
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private bridgeRows(id?: string) {
    return this.prisma.device.findMany({
      where: { role: BRIDGE_ROLE, ...(id ? { id } : {}) },
      orderBy: [{ org: { name: 'asc' } }, { name: 'asc' }],
      select: {
        id: true, name: true, clientId: true, lastSeenAt: true, telemetryIntervalS: true,
        org: { select: { id: true, name: true } },
        bridgedStation: { select: { name: true, deletedAt: true } },
      },
    });
  }

  private identity(d: Awaited<ReturnType<TelemetryAdminService['bridgeRows']>>[number], now: number): BridgeIdentity {
    const station = d.bridgedStation && !d.bridgedStation.deletedAt ? d.bridgedStation.name : null;
    const limit = station ? OFFLINE_AFTER_MS : OFFLINE_AFTER_UNBOUND_MS;
    return {
      id: d.id,
      name: d.name,
      clientId: d.clientId,
      org: d.org,
      station,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      online: !!d.lastSeenAt && now - d.lastSeenAt.getTime() <= limit,
    };
  }

  /** When an outage still going began, or null. Never seen is not an outage. */
  private ongoing(identity: BridgeIdentity, _now: number): Date | null {
    return !identity.online && identity.lastSeenAt ? new Date(identity.lastSeenAt) : null;
  }

  private inRange(r: { bootAt: Date | null; receivedAt: Date }, since: number): boolean {
    return (r.bootAt ?? r.receivedAt).getTime() >= since;
  }

  private totals(
    reports: { bootAt: Date | null; receivedAt: Date; bootsSincePrevious: number; unplannedReboot: boolean; memMinFreeEver: number | null }[],
    outages: { startedAt: Date; endedAt: Date }[],
    ongoingSince: Date | null,
    since: number,
    now: number,
  ): BridgeTotals {
    const boots = reports.filter((r) => r.bootsSincePrevious > 0 && this.inRange(r, since));
    const clipped = (from: number, to: number) => Math.max(0, Math.min(to, now) - Math.max(from, since));
    const disconnectedMs =
      sum(outages.map((o) => clipped(o.startedAt.getTime(), o.endedAt.getTime()))) +
      (ongoingSince ? clipped(ongoingSince.getTime(), now) : 0);
    const lows = reports.map((r) => r.memMinFreeEver).filter((m): m is number => m !== null);
    return {
      reboots: sum(boots.map((r) => r.bootsSincePrevious)),
      unplannedReboots: boots.filter((r) => r.unplannedReboot).length,
      outages: outages.length + (ongoingSince ? 1 : 0),
      disconnectedMs,
      lowestMemory: lows.length ? Math.min(...lows) : null,
      reports: reports.length,
    };
  }

  private async latestFor(ids: string[]): Promise<Map<string, BridgeLatest>> {
    if (ids.length === 0) return new Map();
    // One newest row per device, found by its own time rather than a scan.
    const newest = await this.prisma.deviceTelemetry.groupBy({
      by: ['deviceId'],
      where: { deviceId: { in: ids } },
      _max: { receivedAt: true },
    });
    const rows = await this.prisma.deviceTelemetry.findMany({
      where: {
        OR: newest
          .filter((n) => n._max.receivedAt)
          .map((n) => ({ deviceId: n.deviceId, receivedAt: n._max.receivedAt! })),
      },
    });
    return new Map(rows.map((r) => [r.deviceId, this.latestOf(r)]));
  }

  private latestOf(r: {
    receivedAt: Date; firmwareVersion: string | null; board: string | null; psram: boolean | null;
    bootCount: number | null; resetReason: string | null; bootAt: Date | null; memFree: number | null;
    memLargestBlock: number | null; memMinFreeEver: number | null; wifiRssi: number | null; printerLink: string | null;
  }): BridgeLatest {
    return {
      receivedAt: r.receivedAt.toISOString(),
      firmwareVersion: r.firmwareVersion,
      board: r.board,
      psram: r.psram,
      bootCount: r.bootCount,
      resetReason: r.resetReason,
      bootAt: r.bootAt?.toISOString() ?? null,
      memFree: r.memFree,
      memLargestBlock: r.memLargestBlock,
      memMinFreeEver: r.memMinFreeEver,
      wifiRssi: r.wifiRssi,
      printerLink: r.printerLink,
    };
  }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function lowest(current: number | null, next: number | null): number | null {
  if (next === null) return current;
  return current === null ? next : Math.min(current, next);
}
