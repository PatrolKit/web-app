import { salesHeatmap, soldByCategory } from './sales-heatmap';
import { ItemBreakdownService } from './item-breakdown.service';
import type { PosSaleLine } from './pos/pos.adapter';

/** Sales by hour and sold by category (Plan 46), from Square's sale lines. */

const TZ = 'America/New_York';
const line = (over: Partial<PosSaleLine>): PosSaleLine => ({
  orderId: 'o1', variationId: 'v1', quantity: 1, collectedCents: 4500, unitPriceCents: 5000, refundedQuantity: 0,
  soldAt: new Date('2026-10-10T14:20:00Z'), ...over,
});

describe('sales by hour (D2, D4)', () => {
  it('counts only this swap’s variations, units and what the register took', () => {
    const map = salesHeatmap([
      line({}),
      line({ orderId: 'o2', variationId: 'v2', collectedCents: 3000 }),
      line({ orderId: 'o3', variationId: 'concessions', collectedCents: 250 }),
    ], new Set(['v1', 'v2']), TZ);
    expect(map.totals).toEqual({ units: 2, cents: 7500 });
    expect(map.cells).toEqual([{ date: '2026-10-10', hour: 10, units: 2, cents: 7500 }]);
  });

  it('takes refunds off units and dollars, pro rata', () => {
    const map = salesHeatmap([line({ quantity: 2, collectedCents: 8000, refundedQuantity: 1 }), line({ refundedQuantity: 1 })], new Set(['v1']), TZ);
    expect(map.totals).toEqual({ units: 1, cents: 4000 });
  });

  it('buckets in the swap’s time zone, a sale just after local midnight on the next day', () => {
    const map = salesHeatmap([
      line({ soldAt: new Date('2026-10-11T03:59:00Z') }), // 11:59 PM on the 10th, local
      line({ soldAt: new Date('2026-10-11T04:05:00Z') }), // 12:05 AM on the 11th, local
    ], new Set(['v1']), TZ);
    expect(map.days).toEqual(['2026-10-10', '2026-10-11']);
    expect(map.cells.map((c) => [c.date, c.hour])).toEqual([['2026-10-10', 23], ['2026-10-11', 0]]);
    expect(map.hours).toEqual([0, 23]);
  });

  it('has no days or hours without sales', () => {
    expect(salesHeatmap([], new Set(['v1']), TZ)).toEqual({ days: [], hours: [], cells: [], totals: { units: 0, cents: 0 } });
  });
});

describe('sold by category (D6)', () => {
  it('puts each sale under its item’s category, null for none, and leaves out other sales', () => {
    const sold = soldByCategory([
      line({ variationId: 'ski1' }),
      line({ variationId: 'ski2', quantity: 2 }),
      line({ variationId: 'tag1' }),
      line({ variationId: 'boot1', refundedQuantity: 1 }),
      line({ variationId: 'concessions' }),
    ], new Map<string, string | null>([['ski1', 'skis'], ['ski2', 'skis'], ['tag1', null], ['boot1', 'boots']]));
    expect([...sold]).toEqual([['skis', 3], [null, 1]]);
  });
});

describe('one Square read for every card (D1)', () => {
  function service(lines: PosSaleLine[]) {
    let calls = 0;
    const prisma = {
      skiSwap: { findFirst: async () => ({ id: 'swap', createdAt: new Date('2026-10-01'), locationId: 'loc', timeZone: TZ }) },
      swapItem: {
        findMany: async () => [{ squareVariationId: 'v1', categoryId: 'skis', sku: '1', name: 'Skis', priceCents: 1, consignedAt: new Date(), returnedAt: null, squareItemId: 's1', originalQuantity: 1 }],
      },
    };
    const pos = { forOrg: async () => ({ listSales: async () => { calls += 1; await new Promise((r) => setImmediate(r)); return lines; } }) };
    return { svc: new ItemBreakdownService(prisma as never, pos as never), calls: () => calls };
  }

  it('shares one call between the breakdown, the heat map and sold by category, even asked at once', async () => {
    const t = service([line({})]);
    const [b, h, c] = await Promise.all([t.svc.get('org', 'swap'), t.svc.salesHeatmap('org', 'swap'), t.svc.soldByCategory('org', 'swap')]);
    expect(t.calls()).toBe(1);
    expect(b.sold).toBe(1);
    expect(h.totals.units).toBe(1);
    expect(c.categories).toEqual([{ categoryId: 'skis', units: 1 }]);
    expect(b.asOf).toBe(h.asOf);
  });

  it('says so when Square can’t be read, and asks again next time', async () => {
    let fail = true;
    let calls = 0;
    const prisma = {
      skiSwap: { findFirst: async () => ({ id: 'swap', createdAt: new Date(), locationId: 'loc', timeZone: TZ }) },
      swapItem: { findMany: async () => [] },
    };
    const pos = { forOrg: async () => ({ listSales: async () => { calls += 1; if (fail) throw new Error('Square is down'); return []; } }) };
    const svc = new ItemBreakdownService(prisma as never, pos as never);
    expect((await svc.salesHeatmap('org', 'swap')).error).toBe('Square is down');
    fail = false;
    expect((await svc.soldByCategory('org', 'swap')).error).toBeNull();
    expect(calls).toBe(2);
  });
});
