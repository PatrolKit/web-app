import { LabelRendererService } from './label-renderer.service';
import { printTarget } from './geometry';

/**
 * "Number of barcodes per ticket" (the org's setting): 2 puts a second
 * barcode across the head of the tall tag. The small tag always has one.
 */
const item = { name: 'Rossignol Experience 88 Ti 172cm Red Skis', priceCents: 4500, sku: 'SS26-A-0001' };
const tall = printTarget('m221', '62x100');

/** Black-white changes along a row: a row through bars has dozens. */
const edges = (row: boolean[]) => row.reduce((n, dot, i) => n + (i > 0 && dot !== row[i - 1] ? 1 : 0), 0);
/** The most edges in any row of the top tenth of the label. */
const headEdges = (rows: boolean[][]) => Math.max(...rows.slice(0, Math.round(rows.length / 10)).map(edges));

describe('barcodes per ticket', () => {
  const renderer = new LabelRendererService();

  it('puts a second barcode across the head of the tall tag', async () => {
    const one = await renderer.itemTag({ ...item, barcodes: 1 }, tall);
    const two = await renderer.itemTag({ ...item, barcodes: 2 }, tall);
    expect(headEdges(two)).toBeGreaterThan(60);
    expect(headEdges(one)).toBeLessThan(40);
  });

  it('leaves the tall tag as it was when unset', async () => {
    const unset = await renderer.itemTag(item, tall);
    const one = await renderer.itemTag({ ...item, barcodes: 1 }, tall);
    expect(unset).toEqual(one);
  });

  it('never changes the small tag', async () => {
    const small = printTarget('m110', '50x30');
    expect(await renderer.itemTag({ ...item, barcodes: 2 }, small)).toEqual(await renderer.itemTag(item, small));
  });
});
