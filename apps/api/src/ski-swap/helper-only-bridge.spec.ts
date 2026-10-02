import { ConflictException } from '@nestjs/common';
import { PrintQueueService } from './print-queue.service';

/**
 * A bridge whose printer holds 25 × 67 prints helper labels and nothing else
 * (Plan 28). What an iPad asks such a bridge to print is checked in
 * `station-print.spec.ts`; these are the server's own jobs.
 */

type Printer = { id: string; model: string; paperSize: string; marginTop: number; marginBottom: number; marginLeft: number; marginRight: number };
const printer = (paperSize: string): Printer => ({
  id: 'printer-1', model: 'm221', paperSize, marginTop: 16, marginBottom: 16, marginLeft: 16, marginRight: 16,
});

function harness(opts: {
  paperSize?: string | null;
  bridge?: boolean;
  lastSeenMsAgo?: number | null;
  printerLink?: string | null;
  helperLabelsOn?: boolean;
  attendant?: string;
} = {}) {
  const jobs: Record<string, unknown>[] = [];
  const sql: string[] = [];
  const station = {
    id: 'station-1', name: 'Station 1', code: 'A', orgId: 'org-1',
    attendantDeviceId: opts.attendant ?? 'ipad-1',
    bridge: opts.bridge === false ? null : {
      lastSeenAt: opts.lastSeenMsAgo === null ? null : new Date(Date.now() - (opts.lastSeenMsAgo ?? 1_000)),
      printerLink: opts.printerLink === undefined ? 'ready' : opts.printerLink,
      bridgedPrinter: opts.paperSize === null ? null : printer(opts.paperSize ?? '25x67'),
    },
  };
  const prisma = {
    checkinStation: {
      findFirst: async ({ where }: { where: { id: string; attendantDeviceId?: string } }) =>
        where.id === station.id && (!where.attendantDeviceId || where.attendantDeviceId === station.attendantDeviceId)
          ? station : null,
    },
    skiSwap: { findFirst: async () => ({ printLegacyHelperLabels: opts.helperLabelsOn ?? true }) },
    swapItem: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === 'item-1' ? { id: 'item-1', swapId: 'swap-1', sellerId: null } : null) },
    printJob: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => { jobs.push(data); return data; },
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => { jobs.push(...data); return { count: data.length }; },
      findMany: async () => [],
    },
    device: {
      update: async () => ({}),
      findUnique: async () => ({ lastSeenAt: new Date() }),
      findUniqueOrThrow: async () => ({
        bridgedPrinter: null, bridgedScanner: null, bridgedStations: [{ id: 'station-1', name: 'Station 1', code: 'A' }],
      }),
    },
    $executeRaw: async (strings: TemplateStringsArray) => { sql.push(Array.isArray(strings) ? strings.join('?') : String(strings)); return 0; },
  };
  const queue = new PrintQueueService(prisma as never, {} as never, {} as never, { recordCheckIn: async () => undefined } as never);
  return { queue, jobs, sql };
}

describe('a bridge that holds 25 × 67', () => {
  it('queues no tag when an item is saved there', async () => {
    const { queue, jobs } = harness();
    const queued = await queue.enqueueItemTags({ orgId: 'org-1', stationId: 'station-1', swapId: 'swap-1', sellerId: null, itemId: 'item-1', count: 2 });
    expect(queued).toBe(0);
    expect(jobs).toHaveLength(0);
  });

  it('refuses a tag reprint, saying what it holds', async () => {
    const { queue } = harness();
    const err = await queue.reprintItem('org-1', 'station-1', 'item-1').catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'PRINTER_STOCK' });
  });

  it('queues no receipt pages', async () => {
    const { queue, jobs } = harness();
    await queue.enqueueReceipt({ orgId: 'org-1', stationId: 'station-1', swapId: 'swap-1', sellerId: 'seller-1', pageCount: 2, withHeader: true });
    expect(jobs).toHaveLength(0);
  });

  it('tests itself with a sample pair of helper labels instead of a calibration label', async () => {
    const { queue, jobs } = harness();
    await queue.enqueueCalibration('org-1', 'station-1');
    expect(jobs.map((j) => j.kind)).toEqual(['helper_item', 'helper_office']);
  });

  it('while other stock still queues tags and calibration as before', async () => {
    const { queue, jobs } = harness({ paperSize: '62x100' });
    await queue.enqueueItemTags({ orgId: 'org-1', stationId: 'station-1', swapId: 'swap-1', sellerId: null, itemId: 'item-1', count: 1 });
    await queue.enqueueCalibration('org-1', 'station-1');
    expect(jobs.map((j) => j.kind)).toEqual(['item', 'calibration']);
  });
});

describe('the claim and a helper pair’s minute', () => {
  it('drops expired pairs, and never takes a job past its notAfter', async () => {
    const { queue, sql } = harness();
    await queue.claim('bridge-1', 4, undefined, undefined, undefined, 0);
    const sweep = sql.find((q) => q.includes('Not printed within a minute'));
    expect(sweep).toMatch(/notAfter IS NOT NULL\s+AND notAfter < NOW\(3\)/);
    const take = sql.find((q) => q.includes("SET status = 'claimed'"));
    expect(take).toMatch(/notAfter IS NULL OR notAfter >= NOW\(3\)/);
  });
});
