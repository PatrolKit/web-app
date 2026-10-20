import { Reflector } from '@nestjs/core';
import { attributeSales, classify, compLine, isComp, type CheckItem, type ClassifyInput, type CompRef } from '../sales-check';
import { paidPriceCheck } from '../paid-price-check';
import { buildRun, discountsOf } from '../payouts/build-run';
import { SwapCompController } from './swap-comp.controller';
import { PERMISSIONS_KEY } from '../../common/decorators/require-permissions.decorator';
import { PublicSellerDetailItemSchema, PublicSellerItemSchema, ItemResponseSchema } from '../../contracts/ski-swap.contracts';
import type { PosSaleLine } from '../pos/pos.adapter';

/**
 * Comps (Plan 53): an item marked sold with no Square sale behind it. A comp
 * reads as a sale of its item wherever sales are attributed, with nothing
 * collected, so it counts everywhere at once.
 */

const at = new Date('2026-10-17T19:00:00Z');
const comp = (over: Partial<CompRef> = {}): CompRef => ({ id: 'c1', variationId: 'v-74125', units: 1, priceCents: 6000, compedAt: at, ...over });
const sale = (orderId: string, variationId: string, over: Partial<PosSaleLine> = {}): PosSaleLine => ({
  orderId, variationId, lineUid: `${orderId}-u`, quantity: 1, collectedCents: 6000, unitPriceCents: 6000, refundedQuantity: 0, soldAt: at, paymentId: `pay-${orderId}`, ...over,
});
const item = (sku: string, over: Partial<CheckItem> = {}): CheckItem => ({
  id: `it-${sku}`, sku, name: `Item #${sku}`, priceCents: 6000, sellerName: 'Mary Carocci', sellerId: 's1', squareVariationId: `v-${sku}`, originalQuantity: 1, deleted: false, ...over,
});
const input = (over: Partial<ClassifyInput>): ClassifyInput => ({ lines: [], items: [], decisions: [], described: new Map(), categoryNames: new Map(), ignoredCategoryIds: new Set(), ...over });

describe('a comp, as a sale (D1, D6)', () => {
  it('reads as a sale of its item, at its list price, with nothing collected', () => {
    const lines = attributeSales([], [], [], new Set(), new Map(), [comp()]);
    expect(lines).toEqual([expect.objectContaining({ orderId: 'comp:c1', variationId: 'v-74125', quantity: 1, unitPriceCents: 6000, collectedCents: 0, paymentId: null })]);
    expect(isComp(lines[0])).toBe(true);
  });

  it('counts nothing once undone: an undone comp isn’t passed in', () => {
    expect(attributeSales([sale('o1', 'v-other')], [], [], new Set(), new Map(), [])).toHaveLength(1);
  });

  it('pays the seller the list price, less the patrol’s share', () => {
    const run = buildRun(
      [{ id: 'it-74125', name: 'Item #74125', sku: '74125', priceCents: 6000, squareVariationId: 'v-74125', donateProceeds: false, sellerId: 's1', originalQuantity: 1 }],
      [{ sellerId: 's1', name: 'Mary Carocci', method: 'CHECK', target: null, handle: null, handleScanned: false, verifiedEmail: null, verifiedPhone: null }],
      attributeSales([], [], [], new Set(), new Map(), [comp()]),
      { commissionBasisPoints: 2000 },
    );
    expect(run.lines[0]).toMatchObject({ grossCents: 6000, commissionCents: 1200, netCents: 4800 });
    expect(run.lines[0].items[0]).toMatchObject({ squareOrderId: 'comp:c1', collectedCents: 0, paymentId: null });
  });

  it('is no discount, and no sale at a different price', () => {
    const run = buildRun(
      [{ id: 'it-74125', name: 'Item #74125', sku: '74125', priceCents: 6000, squareVariationId: 'v-74125', donateProceeds: false, sellerId: 's1', originalQuantity: 1 }],
      [{ sellerId: 's1', name: 'Mary Carocci', method: 'CHECK', target: null, handle: null, handleScanned: false, verifiedEmail: null, verifiedPhone: null }],
      [compLine(comp())], { commissionBasisPoints: 0 },
    );
    expect(discountsOf(run.lines).discounts).toEqual([]);
    expect(paidPriceCheck([compLine(comp())], [item('74125')], new Set())).toEqual([]);
  });
});

describe('comped, then rung up in Square (D8)', () => {
  it('is sold twice, with the comp listed among its sales', () => {
    const issues = classify(input({ items: [item('74125')], lines: [sale('o9', 'v-74125')], comps: [comp()] }));
    const oversold = issues.find((i) => i.kind === 'oversold');
    expect(oversold?.oversold?.sales.map((s) => s.orderId).sort()).toEqual(['comp:c1', 'o9']);
  });

  it('is fine while the comp covers the only unit', () => {
    expect(classify(input({ items: [item('74125')], comps: [comp()] }))).toEqual([]);
  });
});

describe('who sees a comp (D6, D9)', () => {
  it('is on the staff item response only: customers never get it', () => {
    expect(Object.keys(ItemResponseSchema.shape)).toContain('comp');
    expect(Object.keys(PublicSellerItemSchema.shape)).not.toContain('comp');
    expect(Object.keys(PublicSellerDetailItemSchema.shape)).not.toContain('comp');
  });

  it('can be made and undone by Ski Swap admins only, and read with report', () => {
    const perms = (name: keyof SwapCompController) => new Reflector().get<string[]>(PERMISSIONS_KEY, SwapCompController.prototype[name] as never);
    expect(perms('create')).toEqual(['ski_swap:admin']);
    expect(perms('undo')).toEqual(['ski_swap:admin']);
    expect(perms('list')).toEqual(['ski_swap:report']);
  });
});
