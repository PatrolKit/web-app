import { describe, expect, it } from 'vitest';
import type { ItemResponse } from '../../lib/api.types';
import { looked, settled } from './scanTicketLogic';

describe('Scan Ticket', () => {
  it('puts each scan first, looking, and ignores a blank read', () => {
    let r = looked([], ' 67169\r', 1);
    expect(r.code).toBe('67169');
    r = looked(r.lookups, 'SP-A-0001', 2);
    expect(r.lookups.map((l) => [l.code, l.state])).toEqual([['SP-A-0001', 'looking'], ['67169', 'looking']]);
    expect(looked(r.lookups, '   ', 3)).toEqual({ lookups: r.lookups, code: null });
  });

  it('keeps the same tag scanned twice as two rows', () => {
    const r = looked(looked([], '67169', 1).lookups, '67169', 2);
    expect(r.lookups.length).toBe(2);
  });

  it('settles each lookup on its own, whatever order the answers come in', () => {
    let lookups = looked(looked([], '1', 1).lookups, '2', 2).lookups;
    lookups = settled(lookups, 2, { state: 'missing' });
    lookups = settled(lookups, 1, { state: 'found', item: { sku: '1' } as ItemResponse });
    expect(lookups.map((l) => [l.code, l.state])).toEqual([['2', 'missing'], ['1', 'found']]);
  });
});
