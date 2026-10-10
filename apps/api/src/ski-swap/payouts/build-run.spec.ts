import { buildRun, discountsOf, resolveDestination } from './build-run';
import type { RunItem, RunSeller } from './build-run';
import type { PosSaleLine } from '../pos/pos.adapter';

const SOLD_AT = new Date('2026-09-18T12:00:00Z');

const item = (over: Partial<RunItem> = {}): RunItem => ({
  id: 'i1', name: 'Skis', sku: 'SW-A-0001', priceCents: 10_000,
  squareVariationId: 'v1', donateProceeds: false, sellerId: 's1', originalQuantity: 1, ...over,
});

const seller = (over: Partial<RunSeller> = {}): RunSeller => ({
  sellerId: 's1', name: 'Dana Reyes', method: 'PAYPAL', target: 'EMAIL',
  handle: null, handleScanned: false, verifiedEmail: 'dana@example.com', verifiedPhone: '+15550101001', ...over,
});

const sale = (over: Partial<PosSaleLine> = {}): PosSaleLine => ({
  orderId: 'o1', variationId: 'v1', quantity: 1, collectedCents: 10_000, unitPriceCents: 10_000,
  refundedQuantity: 0, soldAt: SOLD_AT, ...over,
});

const opts = { commissionBasisPoints: 2000 };

describe('buildRun', () => {
  it('owes the listed price and takes the commission from it', () => {
    const { lines } = buildRun([item()], [seller()], [sale()], opts);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      grossCents: 10_000, commissionCents: 2_000, netCents: 8_000, status: 'PENDING',
    });
  });

  /**
   * The decision in §2, and the one most likely to be quietly "fixed" later:
   * the seller is owed on what the item listed for, whatever the register took.
   */
  it('owes the listed price even when the register discounted it', () => {
    const { lines } = buildRun([item()], [seller()], [sale({ collectedCents: 8_000 })], opts);
    expect(lines[0].grossCents).toBe(10_000);
    expect(lines[0].items[0].collectedCents).toBe(8_000); // kept, never multiplied
  });

  it('does not owe for a unit that came back', () => {
    const { lines } = buildRun(
      [item({ originalQuantity: 3 })], [seller()], [sale({ quantity: 3, refundedQuantity: 1, collectedCents: 30_000 })], opts,
    );
    expect(lines[0].grossCents).toBe(20_000);
    expect(lines[0].items[0].quantity).toBe(2);
  });

  it('pays nothing when everything was returned', () => {
    const { lines } = buildRun(
      [item()], [seller()], [sale({ quantity: 1, refundedQuantity: 1 })], opts,
    );
    expect(lines).toHaveLength(0);
  });

  /** Sold, evidenced, owed to nobody. */
  it('counts a donated item as sold and pays nothing for it', () => {
    const items = [item({ id: 'i1' }), item({ id: 'i2', squareVariationId: 'v2', donateProceeds: true })];
    const sales = [sale(), sale({ variationId: 'v2', orderId: 'o2' })];
    const { lines } = buildRun(items, [seller()], sales, opts);

    expect(lines[0].grossCents).toBe(10_000);          // only the non-donated one
    expect(lines[0].items).toHaveLength(2);            // both are evidence
  });

  it('computes a DONATE seller but marks it never to be sent', () => {
    const { lines } = buildRun([item()], [seller({ method: 'DONATE' })], [sale()], opts);
    expect(lines[0]).toMatchObject({ status: 'DONATED', netCents: 8_000, destination: null });
  });

  /**
   * There is no floor. A run once held anything under a dollar back, on the
   * reasoning that the fee outweighed it — but the money is the seller's
   * either way, and a payout nobody sends is a payout somebody has to chase.
   * Forty cents goes out like four hundred.
   */
  it('sends a payout however small it is', () => {
    const { lines } = buildRun(
      [item({ priceCents: 50 })], [seller()], [sale({ collectedCents: 50 })], opts,
    );
    expect(lines[0]).toMatchObject({ status: 'PENDING', netCents: 40, statusNote: null });
  });

  it('sends a small check on the same terms', () => {
    const { lines } = buildRun(
      [item({ priceCents: 50 })], [seller({ method: 'CHECK', target: null })], [sale({ collectedCents: 50 })], opts,
    );
    expect(lines[0].status).toBe('PENDING');
  });

  /**
   * An unmatched sale is money the org took that nobody is paid for. Reported,
   * because silence is the one response that guarantees nobody looks.
   */
  it('reports a sale that matches no item rather than dropping it', () => {
    const { lines, unmatched } = buildRun([item()], [seller()], [sale({ variationId: 'unknown' })], opts);
    expect(lines).toHaveLength(0);
    expect(unmatched).toEqual([{ variationId: 'unknown', orderId: 'o1', collectedCents: 10_000 }]);
  });

  it('says so when a seller has no usable destination', () => {
    const { lines } = buildRun([item()], [seller({ verifiedEmail: null })], [sale()], opts);
    expect(lines[0].destination).toBeNull();
    expect(lines[0].statusNote).toMatch(/destination/);
  });

  it('rounds once per seller, not once per item', () => {
    const items = Array.from({ length: 100 }, (_, i) => item({ id: `i${i}`, squareVariationId: `v${i}`, priceCents: 999 }));
    const sales = items.map((it, i) => sale({ variationId: `v${i}`, orderId: `o${i}`, collectedCents: 999 }));
    const { lines } = buildRun(items, [seller()], sales, opts);

    expect(lines[0].grossCents).toBe(99_900);
    expect(lines[0].commissionCents).toBe(19_980);  // not 20_000
  });

  it('puts the largest payment first, where it will be looked at hardest', () => {
    const items = [item({ id: 'i1', sellerId: 's1' }), item({ id: 'i2', squareVariationId: 'v2', sellerId: 's2', priceCents: 50_000 })];
    const sellers = [seller(), seller({ sellerId: 's2', name: 'Alex Stone' })];
    const sales = [sale(), sale({ variationId: 'v2', orderId: 'o2', collectedCents: 50_000 })];
    const { lines } = buildRun(items, sellers, sales, opts);

    expect(lines.map((l) => l.sellerName)).toEqual(['Alex Stone', 'Dana Reyes']);
  });
});

describe('resolveDestination', () => {
  it('pays PayPal to the verified email, not a stored copy', () => {
    expect(resolveDestination(seller({ target: 'EMAIL' })))
      .toEqual({ destination: 'dana@example.com', destinationType: 'EMAIL' });
  });

  it('pays no PayPal ID or phone: only somebody’s word for the account (Plan 35)', () => {
    expect(resolveDestination(seller({ target: 'PAYPAL_ID', handle: 'ABC' })).destination).toBeNull();
    expect(resolveDestination(seller({ target: 'PHONE' })).destination).toBeNull();
  });

  it('pays a Venmo handle only once it was scanned from the seller’s code', () => {
    expect(resolveDestination(seller({ method: 'VENMO', target: 'VENMO_ID', handle: '@dana', handleScanned: true })))
      .toEqual({ destination: '@dana', destinationType: 'VENMO_ID' });
    expect(resolveDestination(seller({ method: 'VENMO', target: 'VENMO_ID', handle: '@dana' })).destination).toBeNull();
  });

  it('has nowhere to send a check or a donation', () => {
    expect(resolveDestination(seller({ method: 'CHECK' })).destination).toBeNull();
    expect(resolveDestination(seller({ method: 'DONATE' })).destination).toBeNull();
  });
});

describe('discountsOf', () => {
  const lineWith = (collected: number, priceCents = 10_000, quantity = 1) =>
    buildRun([item({ priceCents })], [seller()],
      [sale({ collectedCents: collected, quantity })], opts).lines;

  it('reports a sale below list, with the gap', () => {
    const { discounts, totalGapCents } = discountsOf(lineWith(8_000));
    expect(discounts).toHaveLength(1);
    expect(discounts[0]).toMatchObject({ listedCents: 10_000, collectedCents: 8_000, gapCents: 2_000 });
    expect(totalGapCents).toBe(2_000);
  });

  it('ignores a sale at or above list', () => {
    expect(discountsOf(lineWith(10_000)).discounts).toHaveLength(0);
    // Above list is a register mistake or a tip, not a discount to net off.
    expect(discountsOf(lineWith(12_000)).discounts).toHaveLength(0);
  });

  it('flags a zero-collected line without totalling it', () => {
    const { discounts, totalGapCents } = discountsOf(lineWith(0));
    expect(discounts[0].zeroCollected).toBe(true);
    expect(totalGapCents).toBe(0);
  });

  it('orders by size, because the biggest give-away is the one to explain', () => {
    const lines = [
      ...buildRun([item({ id: 'a', priceCents: 10_000 })], [seller()], [sale({ collectedCents: 9_000 })], opts).lines,
      ...buildRun([item({ id: 'b', priceCents: 50_000 })], [seller()], [sale({ collectedCents: 20_000 })], opts).lines,
    ];
    const { discounts } = discountsOf(lines);
    expect(discounts.map((d) => d.gapCents)).toEqual([30_000, 1_000]);
  });
});

describe('a ticket rung up more times than it has units (Plan 48)', () => {
  it('pays a priced ticket once, from the earliest sale, and holds the rest', () => {
    const run = buildRun(
      [item({ priceCents: 8900, sku: '87025' })], [seller()],
      [
        sale({ orderId: 'later', soldAt: new Date('2026-10-10T19:03:00Z'), collectedCents: 8900, unitPriceCents: 8900 }),
        sale({ orderId: 'first', soldAt: new Date('2026-10-09T18:17:00Z'), collectedCents: 8900, unitPriceCents: 8900 }),
      ],
      opts,
    );
    expect(run.lines[0].grossCents).toBe(8900);
    expect(run.lines[0].items.map((i) => [i.squareOrderId, i.quantity])).toEqual([['first', 1]]);
    expect(run.held).toEqual([{ itemId: 'i1', sku: '87025', name: 'Skis', sellerId: 's1', units: 1, unitCents: [8900], orders: ['later', 'first'], reason: 'different_sales' }]);
  });

  it('pays one unit of a line rung up as quantity 2, and holds the other', () => {
    const run = buildRun([item({ priceCents: 1900 })], [seller()], [sale({ quantity: 2, collectedCents: 3800, unitPriceCents: 1900 })], opts);
    expect(run.lines[0].items.map((i) => [i.quantity, i.collectedCents])).toEqual([[1, 1900]]);
    expect(run.held).toEqual([expect.objectContaining({ units: 1, unitCents: [1900], reason: 'one_sale' })]);
  });

  it('holds an unpriced ticket whole when it was typed at different prices, and records no price from the register', () => {
    const run = buildRun(
      [item({ priceCents: null, sku: '73297' })], [seller()],
      [sale({ orderId: 'WE', unitPriceCents: 1000, collectedCents: 1000 }), sale({ orderId: 'WE', unitPriceCents: 2000, collectedCents: 2000 })],
      opts,
    );
    expect(run.lines).toEqual([]);
    expect(run.held).toEqual([expect.objectContaining({ sku: '73297', units: 2, unitCents: [1000, 2000], reason: 'different_prices' })]);
    expect(run.pricesFromRegister).toEqual([]);
  });

  it('pays an unpriced ticket once when it was typed at one price, and keeps that price', () => {
    const run = buildRun(
      [item({ priceCents: null })], [seller()],
      [sale({ orderId: 'g', unitPriceCents: 1500, collectedCents: 1500 }), sale({ orderId: 'g', unitPriceCents: 1500, collectedCents: 1500 })],
      opts,
    );
    expect(run.lines[0].grossCents).toBe(1500);
    expect(run.held).toEqual([expect.objectContaining({ units: 1, reason: 'one_sale' })]);
    expect(run.pricesFromRegister).toEqual([{ itemId: 'i1', priceCents: 1500 }]);
  });

  it('holds nothing for a ticket sold once', () => {
    expect(buildRun([item()], [seller()], [sale()], opts).held).toEqual([]);
  });
});

