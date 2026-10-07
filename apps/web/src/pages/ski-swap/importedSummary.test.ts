import { describe, expect, it } from 'vitest';
import { importedSummary, wroteAny } from './ImportSkuOptions';

describe('what an import says it did (Plan 38)', () => {
  const row = (outcome: 'created' | 'updated' | 'ok', generated = false) => ({ line: 2, sku: '1', outcome, generated });

  it('counts tickets described apart from new items', () => {
    expect(importedSummary([row('updated'), row('updated'), row('created', true)])).toBe(
      '2 tickets described; 1 new item, each with a SKU to print a label for. Square catches up over the next minute.',
    );
    expect(importedSummary([row('updated')], 'Stowe Sports')).toBe('1 ticket described for Stowe Sports. Square catches up over the next minute.');
    expect(importedSummary([{ ...row('updated'), categoryId: 'skis' }, row('updated')], 'Stowe Sports')).toBe(
      '2 tickets described for Stowe Sports, 1 with a category. Square catches up over the next minute.',
    );
    // A shop's own new items wait to be accepted, so they aren't headed for Square yet.
    expect(importedSummary([row('created', true)])).toBe('1 new item, each with a SKU to print a label for.');
  });

  it('knows whether anything was written', () => {
    expect(wroteAny([row('ok')])).toBe(false);
    expect(wroteAny([row('updated')])).toBe(true);
    expect(wroteAny(null)).toBe(false);
  });
});
