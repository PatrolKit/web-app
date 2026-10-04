import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrintQueueService } from './print-queue.service';
import type { StationPrintRequest } from '../contracts/ski-swap.contracts';

/**
 * Labels the iPad drew, printed through the station's bridge as sent (iOS
 * Plan 26). Checked against the printer as it is now, queued all at once,
 * dropped if not taken within a minute.
 */

type Printer = { id: string; model: string; paperSize: string; marginTop: number; marginBottom: number; marginLeft: number; marginRight: number };
const printer = (model: string, paperSize: string): Printer => ({
  id: 'printer-1', model, paperSize, marginTop: 16, marginBottom: 16, marginLeft: 16, marginRight: 16,
});

/** The dimensions a page has on each stock: the full head, and the label less 16 feed rows. */
const DIMS: Record<string, { model: string; widthDots: number; heightDots: number }> = {
  '50x30': { model: 'm110', widthDots: 400, heightDots: 224 },
  '62x100': { model: 'm221', widthDots: 576, heightDots: 784 },
  '25x67': { model: 'm221', widthDots: 576, heightDots: 520 },
};

function harness(opts: {
  paperSize?: string | null;
  bridge?: boolean;
  lastSeenMsAgo?: number;
  printerLink?: string | null;
  /** No print tickets at staff check-in (Plan 34). */
  noPrintCheckin?: boolean;
  helperLabelsOn?: boolean;
} = {}) {
  const jobs: Record<string, unknown>[] = [];
  const paperSize = opts.paperSize === undefined ? '62x100' : opts.paperSize;
  const station = {
    id: 'station-1', name: 'Station 1', code: 'A', orgId: 'org-1', attendantDeviceId: 'ipad-1',
    bridge: opts.bridge === false ? null : {
      id: 'bridge-1',
      lastSeenAt: new Date(Date.now() - (opts.lastSeenMsAgo ?? 1_000)),
      printerLink: opts.printerLink === undefined ? 'ready' : opts.printerLink,
      bridgedPrinter: paperSize === null ? null : printer(DIMS[paperSize].model, paperSize),
    },
  };
  const prisma = {
    checkinStation: {
      findFirst: async ({ where }: { where: { id: string; attendantDeviceId?: string } }) =>
        where.id === station.id && where.attendantDeviceId === station.attendantDeviceId ? station : null,
    },
    skiSwap: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === 'swap-1' ? { allowPrintCheckin: !opts.noPrintCheckin, printLegacyHelperLabels: opts.helperLabelsOn ?? true } : null,
    },
    swapItem: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === 'item-1' ? { id: 'item-1' } : null) },
    sellerProfile: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === 'seller-1' ? { id: 'seller-1' } : null) },
    printJob: { createMany: async ({ data }: { data: Record<string, unknown>[] }) => { jobs.push(...data); return { count: data.length }; } },
  };
  const queue = new PrintQueueService(prisma as never, {} as never, {} as never, { recordCheckIn: async () => undefined } as never);
  return { queue, jobs };
}

function request(paperSize: string, over: Partial<StationPrintRequest> = {}): StationPrintRequest {
  const d = DIMS[paperSize];
  const page = (fill: number) => Buffer.alloc((d.widthDots / 8) * d.heightDots, fill).toString('base64');
  return {
    kind: 'item_tag', swapId: 'swap-1', itemId: 'item-1', copies: 1,
    model: d.model, paperSize, widthDots: d.widthDots, heightDots: d.heightDots,
    pages: [page(1), page(2)],
    ...over,
  };
}

const refusal = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConflictException);
  return ((err as ConflictException).getResponse() as { code: string }).code;
};

describe('printing what the iPad drew', () => {
  it('queues every page, copies times, in order, as sent, expiring in a minute', async () => {
    const { queue, jobs } = harness();
    const req = request('62x100', { copies: 2 });
    const res = await queue.printDrawn('ipad-1', 'org-1', 'station-1', req);
    expect(jobs.map((j) => [j.seq, (j.params as { page: number }).page, (j.params as { copy: number }).copy])).toEqual([
      [0, 0, 0], [1, 1, 0], [2, 0, 1], [3, 1, 1],
    ]);
    expect(jobs.every((j) => j.kind === 'drawn_item_tag')).toBe(true);
    expect((jobs[1].raster as Buffer).equals(Buffer.from(req.pages[1], 'base64'))).toBe(true);
    expect(new Set(jobs.map((j) => (j.notAfter as Date).getTime())).size).toBe(1);
    expect(res.jobIds).toEqual(jobs.map((j) => j.id));
  });

  it('ties only a tag to its item, so a receipt can never mark a tag printed', async () => {
    const tag = harness();
    await tag.queue.printDrawn('ipad-1', 'org-1', 'station-1', request('62x100'));
    expect(tag.jobs[0].itemId).toBe('item-1');
    const receipt = harness();
    await receipt.queue.printDrawn('ipad-1', 'org-1', 'station-1', request('62x100', { kind: 'receipt', sellerId: 'seller-1' }));
    expect(receipt.jobs[0]).toMatchObject({ itemId: null, sellerId: 'seller-1', kind: 'drawn_receipt' });
  });

  it('prints for an item that has not synced yet, recording its id in params', async () => {
    const { queue, jobs } = harness();
    await queue.printDrawn('ipad-1', 'org-1', 'station-1', request('62x100', { itemId: 'not-synced' }));
    expect(jobs[0]).toMatchObject({ itemId: null, params: expect.objectContaining({ unsyncedItemId: 'not-synced' }) });
  });

  it('is 404 for another station’s tablet', async () => {
    const { queue } = harness();
    await expect(queue.printDrawn('ipad-2', 'org-1', 'station-1', request('62x100'))).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['NO_BRIDGE', { bridge: false }, 'item_tag'],
    ['BRIDGE_OFFLINE', { lastSeenMsAgo: 30_000 }, 'item_tag'],
    ['NO_PRINTER', { paperSize: null }, 'item_tag'],
    ['PRINTER_OFFLINE', { printerLink: 'down' }, 'item_tag'],
    ['PRINTER_OFFLINE', { printerLink: null }, 'receipt'],
    ['TAGS_OFF', { noPrintCheckin: true }, 'item_tag'],
  ] as const)('refuses with %s, queuing nothing', async (code, opts, kind) => {
    const { queue, jobs } = harness(opts);
    expect(await refusal(queue.printDrawn('ipad-1', 'org-1', 'station-1', request('62x100', { kind })))).toBe(code);
    expect(jobs).toHaveLength(0);
  });

  it.each([
    ['an item tag', 'item_tag', '25x67'],
    ['a receipt', 'receipt', '25x67'],
    ['a QR label', 'seller_qr', '25x67'],
    ['helper labels', 'helper_labels', '62x100'],
    ['helper labels', 'helper_labels', '50x30'],
  ] as const)('refuses %s on stock that does not take it', async (_what, kind, paperSize) => {
    const { queue } = harness({ paperSize });
    expect(await refusal(queue.printDrawn('ipad-1', 'org-1', 'station-1', request(paperSize, { kind })))).toBe('PRINTER_STOCK');
  });

  it('takes each kind on the stock that suits it', async () => {
    for (const [kind, paperSize] of [['item_tag', '50x30'], ['item_tag', '62x100'], ['receipt', '50x30'], ['seller_qr', '62x100'], ['helper_labels', '25x67']] as const) {
      const { queue, jobs } = harness({ paperSize });
      await queue.printDrawn('ipad-1', 'org-1', 'station-1', request(paperSize, { kind }));
      expect(jobs.length).toBeGreaterThan(0);
    }
  });

  it('refuses helper labels while the swap has them off', async () => {
    const { queue } = harness({ paperSize: '25x67', helperLabelsOn: false });
    expect(await refusal(queue.printDrawn('ipad-1', 'org-1', 'station-1', request('25x67', { kind: 'helper_labels' })))).toBe('HELPER_LABELS_OFF');
  });

  it('refuses a raster drawn for settings the printer no longer has', async () => {
    const { queue } = harness({ paperSize: '62x100' });
    // Drawn for 50 × 30 while the printer now holds 62 × 100: the right model, the wrong size.
    const stale = { ...request('62x100'), paperSize: '50x30' };
    expect(await refusal(queue.printDrawn('ipad-1', 'org-1', 'station-1', stale))).toBe('PRINTER_STOCK');
    const shortPage = request('62x100');
    const wrongMargins = { ...shortPage, margins: { top: 0, bottom: 16, left: 16, right: 16 } };
    expect(await refusal(queue.printDrawn('ipad-1', 'org-1', 'station-1', wrongMargins))).toBe('PRINTER_STOCK');
    const rightMargins = { ...shortPage, margins: { top: 16, bottom: 16, left: 16, right: 16 } };
    await expect(queue.printDrawn('ipad-1', 'org-1', 'station-1', rightMargins)).resolves.toBeDefined();
  });

  it('is 400 for a page whose length does not match its dimensions, or too many labels', async () => {
    const { queue, jobs } = harness();
    const req = request('62x100');
    const bad = { ...req, pages: [req.pages[0], Buffer.alloc(100).toString('base64')] };
    await expect(queue.printDrawn('ipad-1', 'org-1', 'station-1', bad)).rejects.toBeInstanceOf(BadRequestException);
    const many = { ...req, pages: Array(20).fill(req.pages[0]), copies: 3 };
    await expect(queue.printDrawn('ipad-1', 'org-1', 'station-1', many)).rejects.toBeInstanceOf(BadRequestException);
    expect(jobs).toHaveLength(0);
  });
});
