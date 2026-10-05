import { describe, expect, it } from 'vitest';
import { checked, emptyBatch, markedTaken, removed, scanned, toSave, uncheckable } from './batchAddLogic';

describe('batch add (Plan 40)', () => {
  it('takes a good scan in as checking, newest first, and asks about it', () => {
    let r = scanned(emptyBatch, '67169\r');
    expect(r.check).toBe('67169');
    r = scanned(r.state, ' 501 ');
    expect(r.state.tickets).toEqual([{ sku: '501', status: 'checking' }, { sku: '67169', status: 'checking' }]);
    expect(r.state.last).toBe('501');
  });

  it('refuses our tags, non-numbers and repeats on the spot, keeping them out of the list', () => {
    const one = scanned(emptyBatch, '501').state;
    for (const [raw, key] of [['SS26-A-0001', 'ourTag'], ['ABC', 'notDigits'], ['501', 'inBatch']] as const) {
      const r = scanned(one, raw);
      expect(r.check).toBeNull();
      expect(r.state.rejection?.key).toBe(key);
      expect(r.state.tickets.length).toBe(1);
    }
    // A good scan clears the refusal.
    expect(scanned(scanned(one, 'ABC').state, '502').state.rejection).toBeNull();
  });

  it('ignores a blank read', () => {
    expect(scanned(emptyBatch, '  ')).toEqual({ state: emptyBatch, check: null });
  });

  it('keeps a free ticket and takes out a taken one, saying whose', () => {
    let s = scanned(scanned(emptyBatch, '501').state, '502').state;
    s = checked(s, '501', { free: true });
    expect(s.tickets.find((t) => t.sku === '501')?.status).toBe('ok');
    s = checked(s, '502', { free: false, holder: 'Stowe Sports' });
    expect(s.tickets.map((t) => t.sku)).toEqual(['501']);
    expect(s.last).toBe('501');
    expect(s.rejection).toMatchObject({ key: 'taken', advice: 'Ticket 502 belongs to Stowe Sports.' });
  });

  it('keeps a ticket it couldn’t check, since Save checks again', () => {
    expect(uncheckable(scanned(emptyBatch, '501').state, '501').tickets[0].status).toBe('ok');
  });

  it('removes a mis-scan, and marks what Save found taken', () => {
    let s = scanned(scanned(scanned(emptyBatch, '1').state, '2').state, '3').state;
    s = removed(s, '3');
    expect(s.tickets.map((t) => t.sku)).toEqual(['2', '1']);
    expect(s.last).toBe('2');
    s = markedTaken(s, [{ sku: '1', holder: 'Dana Reyes' }]);
    expect(s.tickets.find((t) => t.sku === '1')).toMatchObject({ status: 'taken', holder: 'Dana Reyes' });
    expect(toSave(s)).toEqual(['1', '2']);
  });
});
