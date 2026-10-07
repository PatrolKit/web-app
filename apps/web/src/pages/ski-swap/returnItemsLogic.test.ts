import { describe, expect, it } from 'vitest';
import type { ItemResponse } from '../../lib/api.types';
import { bannerFor, canUndoReturn, counts, landed, refused, resent, scanned, stillOut, undone } from './returnItemsLogic';

const item = (id: string, over: Partial<ItemResponse> = {}) =>
  ({ id, sku: id, name: 'Ski boots MP 26', seller: { id: 's1', displayName: 'Little Mountain', phone: null }, ...over }) as ItemResponse;

describe('Return Items’ session (Plan 43)', () => {
  it('lists each scan newest first, sending, and ignores a blank one', () => {
    let { rows } = scanned([], ' 101 ', 1);
    ({ rows } = scanned(rows, '102', 2));
    expect(rows.map((r) => [r.code, r.outcome])).toEqual([['102', 'sending'], ['101', 'sending']]);
    expect(scanned(rows, '   ', 3).code).toBeNull();
  });

  it('says returned in green, with the seller’s name as the headline', () => {
    const rows = landed(scanned([], '101', 1).rows, 1, { item: item('101'), outcome: 'returned', squareChecked: true });
    expect(bannerFor(rows[0])).toEqual({ tone: 'ready', title: 'Returned to Little Mountain', text: '101 · Ski boots MP 26' });
  });

  it('says amber when Square couldn’t be checked, and green for a double scan', () => {
    const unchecked = landed(scanned([], '101', 1).rows, 1, { item: item('101'), outcome: 'returned', squareChecked: false });
    expect(bannerFor(unchecked[0])?.tone).toBe('warn');
    const again = landed(scanned([], '101', 2).rows, 2, { item: item('101', { returnedBy: 'Pat' }), outcome: 'already_returned', squareChecked: true });
    expect(bannerFor(again[0])).toMatchObject({ tone: 'ready', title: 'Already returned to Little Mountain' });
    expect(bannerFor(again[0])?.text).toContain('by Pat');
  });

  it('turns each refusal into a red banner by its code', () => {
    const base = scanned([], '101', 1).rows;
    const cases: [object, string][] = [
      [{ status: 409, code: 'ITEM_SOLD' }, 'sold'],
      [{ status: 409, code: 'WRONG_SELLER', message: 'This is Geigers’ item, not Little Mountain’s. Not returned.' }, 'wrong_seller'],
      [{ status: 409, code: 'NOT_RECEIVED' }, 'not_received'],
      [{ status: 404, code: 'ITEM_NOT_FOUND' }, 'not_found'],
      [{}, 'not_sent'],
      [{ status: 500 }, 'failed'],
    ];
    for (const [err, outcome] of cases) {
      const row = refused(base, 1, err)[0];
      expect(row.outcome).toBe(outcome);
      expect(bannerFor(row)?.tone).toBe('error');
    }
    expect(bannerFor(refused(base, 1, cases[1][0])[0])?.text).toContain('Geigers’ item');
  });

  it('retries a row that wasn’t sent, in place', () => {
    const rows = refused(scanned([], '101', 1).rows, 1, {});
    expect(resent(rows, 1)[0]).toEqual({ key: 1, code: '101', outcome: 'sending' });
  });

  it('counts returned items once, and refusals', () => {
    let rows = scanned([], '101', 1).rows;
    rows = landed(rows, 1, { item: item('101'), outcome: 'returned', squareChecked: true });
    rows = landed(scanned(rows, '101', 2).rows, 2, { item: item('101'), outcome: 'already_returned', squareChecked: true });
    rows = refused(scanned(rows, '999', 3).rows, 3, { status: 404 });
    expect(counts(rows)).toEqual({ returned: 1, refused: 1 });
    expect(counts(undone(rows, 1, item('101')).filter((r) => r.key !== 2))).toEqual({ returned: 0, refused: 1 });
  });

  it('ticks a locked seller’s items off as they come back', () => {
    const list = [{ id: '101', sku: '101', name: 'A', priceCents: 100, units: 1 }, { id: '102', sku: '102', name: 'B', priceCents: 100, units: 1 }];
    const rows = landed(scanned([], '101', 1).rows, 1, { item: item('101'), outcome: 'returned', squareChecked: true });
    expect(stillOut(list, rows).map((i) => i.id)).toEqual(['102']);
  });
});

describe('undoing a return (Plan 43 D4)', () => {
  it('is offered only while none of it has sold', () => {
    const at = '2026-10-19T18:00:00.000Z';
    expect(canUndoReturn({ returnedAt: at, returnedUnits: 1, originalQuantity: 1 })).toBe(true);
    expect(canUndoReturn({ returnedAt: at, returnedUnits: 2, originalQuantity: 3 })).toBe(false);
    expect(canUndoReturn({ returnedAt: null, returnedUnits: null, originalQuantity: 1 })).toBe(false);
  });
});
