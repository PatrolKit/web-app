import { describe, expect, it } from 'vitest';
import {
  BATCH_SIZE, REPEAT_MS, bannerFor, counts, emptySession, failedBatch, landed, nextBatch, retryDelay, scanned, sending, toneFor, undone,
  type Pick, type Session,
} from './batchCategoryLogic';

const skis: Pick = { categoryId: 'skis', attributes: [{ attributeId: 'b-incl', valueId: 'yes' }], rename: false, summary: 'Skis · Bindings included: Yes' };
const boots: Pick = { categoryId: 'boots', attributes: [], rename: false, summary: 'Boots' };

function scan(s: Session, sku: string, pick: Pick | null = skis, at = 0) {
  return scanned(s, sku, pick, at);
}

describe('Batch set category’s session (Plan 45)', () => {
  it('queues a scan at once, and refuses one before anything is picked', () => {
    const { session, effect } = scan(emptySession, ' 67169 ');
    expect(effect).toBe('queued');
    expect(session.rows[0]).toMatchObject({ sku: '67169', outcome: 'waiting' });
    expect(scan(emptySession, '67169', null).effect).toBe('no_pick');
  });

  it('drops a held tag read again within 3 seconds, then answers it as already scanned', () => {
    let s = scan(emptySession, '67169', skis, 0).session;
    const held = scan(s, '67169', skis, 500);
    expect(held.effect).toBe('repeat');
    expect(held.session.rows).toHaveLength(1);
    // Still held: each read pushes the window on.
    s = scan(held.session, '67169', skis, 3000).session;
    expect(s.rows).toHaveLength(1);
    const later = scan(s, '67169', skis, 3000 + REPEAT_MS);
    expect(later.effect).toBe('already');
    expect(later.session.rows[0].outcome).toBe('already');
  });

  it('lets a tag that failed or was undone be scanned again', () => {
    let s = scan(emptySession, '67169').session;
    s = failedBatch(s, [1], { status: 400, message: 'No such category' }).session;
    expect(scan(s, '67169', skis, REPEAT_MS).effect).toBe('queued');
  });

  it('batches the oldest pick’s scans, never mixing picks or rename, never more than 25', () => {
    let s = emptySession;
    for (let i = 0; i < 30; i++) s = scan(s, `S${i}`, skis, i * REPEAT_MS).session;
    s = scan(s, 'B1', boots, 999_999).session;
    s = scan(s, 'R1', { ...skis, rename: true }, 999_999).session;
    const first = nextBatch(s)!;
    expect(first.skus).toHaveLength(BATCH_SIZE);
    expect(first.skus[0]).toBe('S0');
    expect(first.pick.categoryId).toBe('skis');
    s = sending(s, first.keys);
    const second = nextBatch(s)!;
    expect(second.skus).toEqual(['S25', 'S26', 'S27', 'S28', 'S29']);
    s = sending(s, second.keys);
    expect(nextBatch(s)!.skus).toEqual(['B1']);
  });

  it('lands each result on its row', () => {
    let s = scan(emptySession, '1').session;
    s = scan(s, '2', skis, REPEAT_MS).session;
    s = scan(s, '3', skis, 2 * REPEAT_MS).session;
    const b = nextBatch(s)!;
    s = landed(sending(s, b.keys), b.keys, [
      { sku: '1', outcome: 'set', item: { id: 'i1', name: 'Item #1', previousName: null, sellerName: 'Geigers', categoryLabel: 'Skis' } },
      { sku: '2', outcome: 'skipped', item: { id: 'i2', name: 'Boots', previousName: null, sellerName: null, categoryLabel: 'Boots' } },
      { sku: '3', outcome: 'not_found' },
    ]);
    expect(s.rows.map((r) => [r.sku, r.outcome])).toEqual([['3', 'not_found'], ['2', 'skipped'], ['1', 'set']]);
    expect(counts(s)).toEqual({ set: 1, skipped: 1, notFound: 1, failed: 0, waiting: 0 });
    expect(bannerFor(s.rows[1])?.title).toBe('Skipped: already a Boots item');
  });

  it('puts a batch with no answer back to wait, and retries later and later', () => {
    let s = scan(emptySession, '1').session;
    const b = nextBatch(s)!;
    const r = failedBatch(sending(s, b.keys), b.keys, {});
    expect(r.retry).toBe(true);
    expect(r.session.rows[0].outcome).toBe('waiting');
    expect(failedBatch(s, b.keys, { status: 503 }).retry).toBe(true);
    expect([0, 1, 2, 3, 9].map(retryDelay)).toEqual([1000, 2000, 5000, 10000, 10000]);
    const refused = failedBatch(s, b.keys, { status: 400, message: '"Model" only applies once "Marker" is chosen' });
    expect(refused.retry).toBe(false);
    s = refused.session;
    expect(bannerFor(s.rows[0])).toMatchObject({ tone: 'error', title: 'Not set' });
  });

  it('sounds the worst of what landed together', () => {
    expect(toneFor(['set', 'set'])).toBe('success');
    expect(toneFor(['set', 'skipped'])).toBe('skip');
    expect(toneFor(['set', 'skipped', 'not_found'])).toBe('error');
    expect(toneFor([])).toBeNull();
  });

  it('says a rename on the banner, and undo puts the old name on the row', () => {
    let s = scan(emptySession, '1', { ...skis, rename: true }).session;
    const b = nextBatch(s)!;
    s = landed(s, b.keys, [{ sku: '1', outcome: 'set', item: { id: 'i1', name: 'Skis', previousName: 'Item #1', sellerName: null, categoryLabel: 'Skis' } }]);
    expect(bannerFor(s.rows[0])?.text).toBe('1 · renamed from Item #1 to Skis');
    s = undone(s, s.rows[0].key, 'Item #1');
    expect(s.rows[0]).toMatchObject({ outcome: 'undone', item: { name: 'Item #1' } });
    expect(counts(s).set).toBe(0);
  });
});
