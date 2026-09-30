import { ConflictException, NotFoundException } from '@nestjs/common';
import { HELPER_LABEL_TTL_MS, PrintQueueService, type HelperLabelRequest } from './print-queue.service';

/**
 * Legacy helper labels through a bridge (Plan 28).
 *
 * A bridge whose printer holds 25 × 67 prints helper labels and nothing else,
 * and a tablet asking for a pair is told at once whether it will print.
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

const REQUEST: HelperLabelRequest = {
  swapId: 'swap-1', itemId: 'item-1', ticket: '10042',
  name: 'Volkl Kendo 88 176cm', itemName: 'Volkl Kendo 88', size: '176cm', priceCents: 24900, sellerName: 'Dana Reyes',
};

describe('asking a bridge for helper labels', () => {
  it('queues the pair as one batch that expires in a minute, with the text as sent', async () => {
    const { queue, jobs } = harness();
    const before = Date.now();
    const res = await queue.printHelperLabels('ipad-1', 'org-1', 'station-1', REQUEST);
    expect(jobs.map((j) => [j.kind, j.seq])).toEqual([['helper_item', 0], ['helper_office', 1]]);
    expect(jobs.every((j) => (j.notAfter as Date).getTime() >= before + HELPER_LABEL_TTL_MS)).toBe(true);
    expect(jobs[0].notAfter).toEqual(jobs[1].notAfter);
    expect(jobs[0]).toMatchObject({ itemId: 'item-1', stationId: 'station-1', params: {
      ticket: '10042', name: REQUEST.name, itemName: REQUEST.itemName, size: '176cm', priceCents: 24900, sellerName: 'Dana Reyes',
    } });
    expect(res.jobIds).toEqual(jobs.map((j) => j.id));
  });

  it('prints for an item that has not synced yet, recording none', async () => {
    const { queue, jobs } = harness();
    await queue.printHelperLabels('ipad-1', 'org-1', 'station-1', { ...REQUEST, itemId: 'not-synced-yet' });
    expect(jobs[0].itemId).toBeNull();
  });

  const refusals: [string, Parameters<typeof harness>[0]][] = [
    ['HELPER_LABELS_OFF', { helperLabelsOn: false }],
    ['NO_BRIDGE', { bridge: false }],
    ['BRIDGE_OFFLINE', { lastSeenMsAgo: 30_000 }],
    ['BRIDGE_OFFLINE', { lastSeenMsAgo: null }],
    ['NO_PRINTER', { paperSize: null }],
    ['PRINTER_STOCK', { paperSize: '62x100' }],
    ['PRINTER_OFFLINE', { printerLink: 'down' }],
    ['PRINTER_OFFLINE', { printerLink: null }],
  ];
  it.each(refusals)('refuses with %s, queuing nothing', async (code, opts) => {
    const { queue, jobs } = harness(opts);
    const err = await queue.printHelperLabels('ipad-1', 'org-1', 'station-1', REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code });
    expect(jobs).toHaveLength(0);
  });

  it('is 404 for a tablet that is not this station’s', async () => {
    const { queue } = harness();
    await expect(queue.printHelperLabels('ipad-2', 'org-1', 'station-1', REQUEST)).rejects.toBeInstanceOf(NotFoundException);
  });
});

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
