import { buildRun, discountsOf, resolveDestination } from './build-run';
import type { RunItem, RunSeller } from './build-run';
import type { PosSaleLine } from '../pos/pos.adapter';

const SOLD_AT = new Date('2026-09-18T12:00:00Z');

const item = (over: Partial<RunItem> = {}): RunItem => ({
  id: 'i1', name: 'Skis', sku: 'SW-A-0001', priceCents: 10_000,
  squareVariationId: 'v1', donateProceeds: false, sellerId: 's1', ...over,
});

const seller = (over: Partial<RunSeller> = {}): RunSeller => ({
  sellerId: 's1', name: 'Dana Reyes', method: 'PAYPAL', target: 'EMAIL',
  handle: null, verifiedEmail: 'dana@example.com', verifiedPhone: '+15550101001', ...over,
});

const sale = (over: Partial<PosSaleLine> = {}): PosSaleLine => ({
  orderId: 'o1', variationId: 'v1', quantity: 1, collectedCents: 10_000,
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
      [item()], [seller()], [sale({ quantity: 3, refundedQuantity: 1, collectedCents: 30_000 })], opts,
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
  it('reads a contact destination from the verified contact, not a stored copy', () => {
    expect(resolveDestination(seller({ target: 'EMAIL' })))
      .toEqual({ destination: 'dana@example.com', destinationType: 'EMAIL' });
    expect(resolveDestination(seller({ target: 'PHONE' })))
      .toEqual({ destination: '+15550101001', destinationType: 'PHONE' });
  });

  it('reads a typed id from the handle', () => {
    expect(resolveDestination(seller({ target: 'PAYPAL_ID', handle: 'ABC' })))
      .toEqual({ destination: 'ABC', destinationType: 'PAYPAL_ID' });
    expect(resolveDestination(seller({ method: 'VENMO', target: 'VENMO_ID', handle: '@dana' })))
      .toEqual({ destination: '@dana', destinationType: 'VENMO_ID' });
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
