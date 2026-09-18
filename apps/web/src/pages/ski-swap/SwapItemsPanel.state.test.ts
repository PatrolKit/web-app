import { describe, expect, it } from 'vitest';
import { ITEM_STATE_FILTERS, itemState } from './SwapItemsPanel';
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
  it('is awaiting a scan before anything else, however the numbers read', () => {
    const unscanned = item({ consignedAt: null, squareSynced: false, inStock: 0 });
    expect(unscanned.soldCount).toBe(1); // the misleading number, still there
    expect(itemState(unscanned).label).toBe('Awaiting scan');
  });

  /** Accepted, but the push failed. It cannot sell, and it is not waiting. */
  it('distinguishes a failed push from a missing scan', () => {
    expect(itemState(item({ squareSynced: false, inStock: 0 })).label).toBe('Not in Square');
  });

  it('ranks by what stops a sale first', () => {
    // Unscanned *and* unsynced is unscanned: scanning it fixes both.
    const both = item({ consignedAt: null, squareSynced: false, inStock: 0 });
    expect(itemState(both).label).toBe('Awaiting scan');
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
   * failed-push state is the one somebody most needs to find.
   */
  it('offers a filter for every state it can return', () => {
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
    // And nothing offered that cannot happen.
    expect(ITEM_STATE_FILTERS).toHaveLength(4);
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
