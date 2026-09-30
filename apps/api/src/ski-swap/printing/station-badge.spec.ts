import { LabelRendererService } from './label-renderer.service';
import { BRANDING_STRIP_W, CONTENT_BRANDING_GAP, geometryOf, printTarget, type PrintTarget } from './geometry';
import { formatSku, SKU_CODE_ALPHABET, stationCodeOf } from '../sku.util';

/**
 * The station's letter on every tag (Plan 27), read from the SKU.
 *
 * Several counters can share one bridge's printer, and nothing else on a tag
 * says which counter it came from.
 */

describe('stationCodeOf', () => {
  it('reads the code out of a station-minted SKU', () => {
    expect(stationCodeOf('SS26-A-0001')).toBe('A');
    expect(stationCodeOf('SSWAP2-K-10042')).toBe('K');
  });

  it('finds none in a web-entered SKU or a legacy ticket number', () => {
    expect(stationCodeOf('SS26-0001')).toBeNull();
    expect(stationCodeOf('10042')).toBeNull();
    expect(stationCodeOf('SS26-I-0001')).toBeNull(); // I is never allocated
  });

  it('round-trips with formatSku for every code there is', () => {
    for (const code of SKU_CODE_ALPHABET) expect(stationCodeOf(formatSku('SS26', code, 7))).toBe(code);
    expect(stationCodeOf(formatSku('SS26', null, 7))).toBeNull();
  });
});

/** The share of a square of the raster that is black, in content-box coordinates. */
function inkIn(rows: boolean[][], target: PrintTarget, x: number, y: number, size: number): number {
  const { mediaOffsetDots } = geometryOf(target);
  const left = mediaOffsetDots + target.margins.marginLeft + x;
  const top = target.margins.marginTop + y;
  let black = 0;
  for (let r = top; r < top + size; r++) for (let c = left; c < left + size; c++) if (rows[r]?.[c]) black++;
  return black / (size * size);
}

describe('the station badge', () => {
  const renderer = new LabelRendererService();
  const item = (sku: string) => ({ name: 'Volkl Kendo 88 skis', priceCents: 24900, sku });

  it('sits beside the price on a 50 × 30 tag, and only when the SKU has a station', async () => {
    const target = printTarget('m110', '50x30');
    const { canvasHeightDots } = geometryOf(target);
    const innerH = canvasHeightDots - target.margins.marginTop - target.margins.marginBottom;
    const at = [0, Math.floor(innerH / 2) + 22, 38] as const;
    expect(inkIn(await renderer.itemTag(item('SS26-A-0001'), target), target, ...at)).toBeGreaterThan(0.6);
    expect(inkIn(await renderer.itemTag(item('SS26-0001'), target), target, ...at)).toBe(0);
    // It is to the left of the content and never reaches the branding strip.
    expect(38).toBeLessThan(geometryOf(target).mediaWidthDots - BRANDING_STRIP_W - CONTENT_BRANDING_GAP);
  });

  it('heads the price column on a 62 × 100 tag, and only when the SKU has a station', async () => {
    const target = printTarget('m221', '62x100');
    const contentW = geometryOf(target).mediaWidthDots - target.margins.marginLeft - target.margins.marginRight;
    const at = [0, 0, Math.round(contentW * 0.13)] as const;
    expect(inkIn(await renderer.itemTag(item('SS26-A-0001'), target), target, ...at)).toBeGreaterThan(0.6);
    expect(inkIn(await renderer.itemTag(item('SS26-0001'), target), target, ...at)).toBe(0);
  });

  it('stays below the barcode on a 50 × 30 tag', async () => {
    // The bars are the top 64 rows of the content box, and the widest SKU
    // already needs their full width, so the badge must start below them.
    const target = printTarget('m110', '50x30');
    const { canvasHeightDots } = geometryOf(target);
    const innerH = canvasHeightDots - target.margins.marginTop - target.margins.marginBottom;
    const badgeTop = Math.floor(innerH / 2) + 22;
    expect(badgeTop).toBeGreaterThan(64);
    // And nothing of it is drawn in the rows the bars use.
    const rows = await renderer.itemTag(item('SS26-A-0001'), target);
    const plain = await renderer.itemTag(item('SS26-A-0001'.replace('-A-', '-')), target);
    expect(inkIn(rows, target, 0, 64, 38)).toBe(inkIn(plain, target, 0, 64, 38));
  });
});
