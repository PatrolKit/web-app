import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { bootsSince, readReport } from './telemetry-report';
import { TelemetryService } from './telemetry.service';
import { TelemetryAdminService } from './telemetry-admin.service';

/** The report in the firmware's handoff, verbatim. */
const REPORT = {
  v: 1,
  firmware: { version: '797451c', board: 'sparkle_motion_mini', idf: 'v6.0' },
  boot: { count: 42, resetReason: 'poweron', uptimeMs: 24320049 },
  memory: { free: 25636, largestBlock: 16384, minFreeEver: 12000, psram: false },
  wifi: { rssi: -61, reconnects: 0 },
  session: { tokenRefreshes: 6, requestFailures: 0 },
  printer: { link: 'ready', reconnects: 3, jobsPrinted: 1, jobsFailed: 0, rasterFailures: 0, rasterReRenders: 0 },
  scanner: { link: 'down', reconnects: 1, battery: 100, scansAccepted: 0, scansRejected: 0, scansDropped: 0 },
  pixels: { framesNotSent: 0 },
};

describe('reading a report', () => {
  it('copies out the fields worth querying', () => {
    expect(readReport(REPORT)).toEqual({
      columns: {
        v: 1, firmwareVersion: '797451c', board: 'sparkle_motion_mini', bootCount: 42, resetReason: 'poweron',
        uptimeMs: 24320049, memFree: 25636, memLargestBlock: 16384, memMinFreeEver: 12000, psram: false,
        wifiRssi: -61, printerLink: 'ready',
      },
      malformed: [],
    });
  });

  it('treats anything missing or null as unknown, not as wrong', () => {
    const { columns, malformed } = readReport({ v: 1, memory: null, boot: { count: 3 } });
    expect(columns).toMatchObject({ bootCount: 3, memFree: null, firmwareVersion: null, psram: null });
    expect(malformed).toEqual([]);
  });

  it('drops a wrongly typed field from the columns and names it, keeping the rest', () => {
    const { columns, malformed } = readReport({
      ...REPORT, memory: { ...REPORT.memory, free: '25 KB', psram: 'no' }, boot: { ...REPORT.boot, count: 4.5 },
    });
    expect(malformed.sort()).toEqual(['boot.count', 'memory.free', 'memory.psram']);
    expect(columns).toMatchObject({ memFree: null, psram: null, bootCount: null, memMinFreeEver: 12000 });
  });

  it('stores a reset reason it has never heard of as it is', () => {
    expect(readReport({ boot: { resetReason: 'cosmic_ray' } }).columns.resetReason).toBe('cosmic_ray');
  });
});

describe('counting boots between reports', () => {
  const at = (bootCount: number | null, uptimeMs: number | null) => ({ bootCount, uptimeMs });
  it('sees none while the count holds', () => expect(bootsSince(at(42, 900_000), at(42, 600_000))).toBe(0));
  it('sees one for the next count', () => expect(bootsSince(at(43, 5_000), at(42, 600_000))).toBe(1));
  it('sees every boot of a crash loop it could not hear', () => expect(bootsSince(at(47, 5_000), at(42, 600_000))).toBe(5));
  it('sees one for a re-provisioned board', () => expect(bootsSince(at(1, 5_000), at(42, 600_000))).toBe(1));
  it('sees one when the uptime went back but the count did not save', () =>
    expect(bootsSince(at(42, 5_000), at(42, 600_000))).toBe(1));
  it('counts a device’s first report as its current boot', () => expect(bootsSince(at(42, 5_000), null)).toBe(1));
  it('sees nothing in a report that says nothing about boots', () => expect(bootsSince(at(null, null), null)).toBe(0));
});

function ingestHarness(previous: { bootCount: number; uptimeMs: bigint } | null = null, intervalS: number | null = null) {
  const created: Record<string, unknown>[] = [];
  const outages: Record<string, unknown>[] = [];
  const prisma = {
    deviceTelemetry: {
      findFirst: async () => previous,
      create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data; },
      deleteMany: async () => ({ count: 0 }),
    },
    deviceOutage: {
      create: async ({ data }: { data: Record<string, unknown> }) => { outages.push(data); return data; },
      deleteMany: async () => ({ count: 0 }),
    },
    device: { findUnique: async () => ({ telemetryIntervalS: intervalS }) },
  };
  return { service: new TelemetryService(prisma as never), created, outages };
}

describe('taking a report', () => {
  it('keeps the whole body as sent, fields it does not know included', async () => {
    const { service, created } = ingestHarness();
    const body = { ...REPORT, radio: { channel: 6 }, somethingNew: [1, 2, 3] };
    await service.ingest('bridge-1', body);
    expect(created[0].body).toEqual(body);
  });

  it('works out when the bridge booted, by our clock', async () => {
    const { service, created } = ingestHarness();
    const before = Date.now();
    await service.ingest('bridge-1', REPORT);
    const bootAt = (created[0].bootAt as Date).getTime();
    expect(bootAt).toBeGreaterThanOrEqual(before - REPORT.boot.uptimeMs);
    expect(bootAt).toBeLessThanOrEqual(Date.now() - REPORT.boot.uptimeMs);
  });

  it('marks a new boot from a crash or a power fault as unplanned', async () => {
    for (const reason of ['panic', 'task_wdt', 'brownout']) {
      const { service, created } = ingestHarness({ bootCount: 41, uptimeMs: 9_000_000n });
      await service.ingest('bridge-1', { ...REPORT, boot: { count: 42, resetReason: reason, uptimeMs: 4_000 } });
      expect({ reason, ...created[0] }).toMatchObject({ reason, bootsSincePrevious: 1, unplannedReboot: true });
    }
  });

  it('does not mark a reset button, or a report within the same boot', async () => {
    const pressed = ingestHarness({ bootCount: 41, uptimeMs: 9_000_000n });
    await pressed.service.ingest('bridge-1', { ...REPORT, boot: { count: 42, resetReason: 'poweron', uptimeMs: 4_000 } });
    expect(pressed.created[0]).toMatchObject({ bootsSincePrevious: 1, unplannedReboot: false });

    const same = ingestHarness({ bootCount: 42, uptimeMs: 4_000n });
    await same.service.ingest('bridge-1', { ...REPORT, boot: { count: 42, resetReason: 'panic', uptimeMs: 304_000 } });
    expect(same.created[0]).toMatchObject({ bootsSincePrevious: 0, unplannedReboot: false });
  });

  it('keeps a report with a wrongly typed field, and says which', async () => {
    const { service, created } = ingestHarness();
    await service.ingest('bridge-1', { ...REPORT, wifi: { rssi: 'weak' } });
    expect(created[0]).toMatchObject({ wifiRssi: null, malformedFields: ['wifi.rssi'], memFree: 25636 });
  });

  it('refuses only a body that is not an object, or is too big', async () => {
    const { service } = ingestHarness();
    for (const body of [null, [1, 2], 'hello', 42]) {
      await expect(service.ingest('bridge-1', body)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(service.ingest('bridge-1', REPORT, 4097)).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(service.ingest('bridge-1', { pad: 'x'.repeat(5000) })).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('tells the bridge how often to report: its own setting, or 300', async () => {
    await expect(ingestHarness().service.ingest('bridge-1', REPORT)).resolves.toEqual({ intervalS: 300 });
    await expect(ingestHarness(null, 60).service.ingest('bridge-1', REPORT)).resolves.toEqual({ intervalS: 60 });
  });
});

describe('outages from check-ins', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('records a gap over twenty seconds for a bridge serving a station', async () => {
    const { service, outages } = ingestHarness();
    await service.recordCheckIn('bridge-1', ago(11_000), now, true);
    expect(outages).toHaveLength(0);
    await service.recordCheckIn('bridge-1', ago(21_000), now, true);
    expect(outages).toEqual([{ deviceId: 'bridge-1', startedAt: ago(21_000), endedAt: now }]);
  });

  it('allows an unbound bridge its thirty-second retries', async () => {
    const { service, outages } = ingestHarness();
    await service.recordCheckIn('bridge-1', ago(35_000), now, false);
    expect(outages).toHaveLength(0);
    await service.recordCheckIn('bridge-1', ago(71_000), now, false);
    expect(outages).toHaveLength(1);
  });

  it('records nothing for a bridge seen for the first time', async () => {
    const { service, outages } = ingestHarness();
    await service.recordCheckIn('bridge-1', null, now, true);
    expect(outages).toHaveLength(0);
  });
});

describe('a bridge’s totals over a range', () => {
  const HOUR = 3_600_000;
  const admin = new TelemetryAdminService({} as never);
  // Private, and public to its behavior: every range figure on the page is this.
  const totals = admin as unknown as {
    totals: (
      reports: { bootAt: Date | null; receivedAt: Date; bootsSincePrevious: number; unplannedReboot: boolean; memMinFreeEver: number | null }[],
      outages: { startedAt: Date; endedAt: Date }[],
      ongoingSince: Date | null,
      since: number,
      now: number,
    ) => Record<string, number | null>;
  };
  const now = Date.parse('2026-09-25T12:00:00Z');
  const since = now - 24 * HOUR;
  const t = (hoursAgo: number) => new Date(now - hoursAgo * HOUR);

  it('clips outages to the range and adds one still going', () => {
    const result = totals.totals(
      [],
      [
        { startedAt: t(30), endedAt: t(23) }, // one hour of it inside
        { startedAt: t(5), endedAt: t(4) },
      ],
      t(0.5),
      since,
      now,
    );
    expect(result).toMatchObject({ disconnectedMs: 2.5 * HOUR, outages: 3 });
  });

  it('counts reboots by when they happened, and every boot of a crash loop', () => {
    const report = (bootHoursAgo: number, boots: number, unplanned: boolean, min: number | null) => ({
      bootAt: t(bootHoursAgo), receivedAt: t(Math.min(bootHoursAgo, 1)), bootsSincePrevious: boots,
      unplannedReboot: unplanned, memMinFreeEver: min,
    });
    const result = totals.totals(
      [
        report(2, 3, true, 11_800), // a loop of three, the last a crash
        report(10, 1, false, 12_400),
        report(200, 1, false, 9_000), // booted a week ago, first reported today: not today's reboot
        report(3, 0, false, null),
      ],
      [],
      null,
      since,
      now,
    );
    expect(result).toMatchObject({ reboots: 4, unplannedReboots: 1, lowestMemory: 9_000, reports: 4 });
  });
});
