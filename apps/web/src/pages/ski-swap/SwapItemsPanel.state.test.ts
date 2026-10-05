import { describe, expect, it } from 'vitest';
import { ITEM_STATE_FILTERS, itemState, matchesStatus } from './SwapItemsPanel';
import type { ItemResponse } from '../../lib/api.types';

/**
 * `soldCount` is not a recorded fact — the server computes it as
 * `originalQuantity - inStock`, and `inStock` is zero for anything Square has
 * never heard of. Every case below is written against that, because it is the
 * reason the two columns this replaces were wrong.
 */
const item = (over: Partial<ItemResponse> = {}): ItemResponse => {
  const base = {
    originalQuantity: 1,
    inStock: 1,
    consignedAt: '2026-09-18T12:00:00.000Z',
    squareSynced: true,
    inventoryKnown: true,
    ...over,
  };
  return {
    ...base,
    soldCount: Math.max(0, base.originalQuantity - base.inStock),
  } as ItemResponse;
};

describe('itemState', () => {
  it('is for sale when it is in Square with stock', () => {
    expect(itemState(item()).label).toBe('For sale');
  });

  it('is sold when Square has none left', () => {
    expect(itemState(item({ inStock: 0 })).label).toBe('Sold');
  });

  /**
   * The case that motivated the column. An unscanned item has no Square
   * variation, so `inStock` is 0 and `soldCount` is the whole quantity — it
   * rendered as fully sold in a table whose other column said "0 in stock".
   */
  it('is not yet received before anything else, however the numbers read', () => {
    const unscanned = item({ consignedAt: null, squareSynced: false, inStock: 0 });
    expect(unscanned.soldCount).toBe(1); // the misleading number, still there
    expect(itemState(unscanned).label).toBe('Not yet received');
  });

  /** Accepted, but the push failed. It cannot sell, and it is not waiting. */
  it('distinguishes a failed push from a missing scan', () => {
    expect(itemState(item({ squareSynced: false, inStock: 0 })).label).toBe('Not in Square');
  });

  /**
   * Square could not be read. The server fills in "unsold" as a placeholder,
   * and the screen must not pass that off as a fact either way: a Square
   * outage used to show every item in the swap as sold.
   */
  it('says the stock is unknown rather than guessing when Square did not answer', () => {
    expect(itemState(item({ inventoryKnown: false, inStock: 1 })).label).toBe('Stock unknown');
    expect(itemState(item({ inventoryKnown: false, inStock: 0 })).label).toBe('Stock unknown');
  });

  it('still puts a missing scan and a failed push ahead of unknown stock', () => {
    expect(itemState(item({ inventoryKnown: false, consignedAt: null, squareSynced: false })).label).toBe('Not yet received');
    expect(itemState(item({ inventoryKnown: false, squareSynced: false })).label).toBe('Not in Square');
  });

  it('ranks by what stops a sale first', () => {
    // Unscanned *and* unsynced is unscanned: scanning it fixes both.
    const both = item({ consignedAt: null, squareSynced: false, inStock: 0 });
    expect(itemState(both).label).toBe('Not yet received');
  });

  describe('quantities', () => {
    it('says nothing about counts for a single item', () => {
      expect(itemState(item()).label).toBe('For sale');
      expect(itemState(item({ inStock: 0 })).label).toBe('Sold');
    });

    it('counts what is left when there is more than one', () => {
      expect(itemState(item({ originalQuantity: 5, inStock: 3 })).label).toBe('For sale · 3 of 5 left');
    });

    it('counts what went when they are all gone', () => {
      expect(itemState(item({ originalQuantity: 5, inStock: 0 })).label).toBe('Sold · 5 of 5');
    });
  });

  /**
   * The filter beside this column selects on `key`. If a state existed that no
   * option could reach, it would be a row nobody could search for — and the
   * failed-push state is the one somebody most needs to find. "Stock unknown"
   * is the exception: it's Square not answering, not something about the
   * item, and a notice above the table says so instead.
   */
  it('offers a filter for every state an item can be in', () => {
    const reachable = [
      itemState(item()),
      itemState(item({ inStock: 0 })),
      itemState(item({ consignedAt: null, squareSynced: false, inStock: 0 })),
      itemState(item({ squareSynced: false, inStock: 0 })),
    ].map((s) => s.key);

    expect(new Set(reachable).size).toBe(4);
    for (const key of reachable) {
      expect(ITEM_STATE_FILTERS.some((f) => f.value === key)).toBe(true);
    }
    expect(ITEM_STATE_FILTERS.map((f) => f.label)).toEqual([
      'Not yet received', 'For sale', 'Sold', 'Not in Square', 'Needs a price',
    ]);
  });

  it('filters on status, and on a missing price whatever the status', () => {
    expect(matchesStatus(item({ inStock: 0 }), 'sold')).toBe(true);
    expect(matchesStatus(item({ inStock: 0 }), 'for_sale')).toBe(false);
    expect(matchesStatus(item({ priceCents: null }), 'needs_price')).toBe(true);
    expect(matchesStatus(item({ priceCents: null, consignedAt: null }), 'needs_price')).toBe(true);
    expect(matchesStatus(item(), 'needs_price')).toBe(false);
    // Stock unknown is under none of the stock states.
    expect(matchesStatus(item({ inventoryKnown: false }), 'for_sale')).toBe(false);
    expect(matchesStatus(item({ inventoryKnown: false }), 'sold')).toBe(false);
    expect(matchesStatus(item({ inventoryKnown: false }), '')).toBe(true);
  });

  it('gives every state a tone and an explanation', () => {
    const cases = [
      item(),
      item({ inStock: 0 }),
      item({ consignedAt: null, squareSynced: false, inStock: 0 }),
      item({ squareSynced: false, inStock: 0 }),
    ];
    for (const c of cases) {
      const st = itemState(c);
      expect(st.tone).toMatch(/bg-/);
      // The chip is two words; the tooltip is where "why" lives.
      expect(st.title.length).toBeGreaterThan(20);
    }
  });
});
