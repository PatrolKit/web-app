import * as fs from 'fs';
import * as path from 'path';
import { LabelRendererService, packRaster } from './label-renderer.service';
import { geometryOf, printTarget, type PrintTarget } from './geometry';

/**
 * Golden-image tests.
 *
 * Rendering has no natural assertion — "it looks right" is not something a test
 * can say — so the port is pinned by comparing packed rasters against committed
 * references. Any change to layout, fonts, or the compositor shows up as a byte
 * difference rather than as a subtly wrong label discovered at a venue.
 *
 * The same fixtures are the reference the firmware team tests against.
 *
 * To re-baseline after an intentional change: `UPDATE_GOLDEN=1 pnpm test`.
 */
const FIXTURES = path.join(__dirname, '__fixtures__');

function expectGolden(name: string, rows: boolean[][]): void {
  const file = path.join(FIXTURES, `${name}.bin`);
  const actual = packRaster(rows);

  if (process.env.UPDATE_GOLDEN || !fs.existsSync(file)) {
    fs.writeFileSync(file, actual);
    return;
  }

  const expected = fs.readFileSync(file);
  if (!actual.equals(expected)) {
    // Byte equality alone is unhelpful on failure, so say how far off it is.
    let differing = 0;
    for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
      if (actual[i] !== expected[i]) differing++;
    }
    throw new Error(
      `${name}: raster differs from golden — ${differing} of ${expected.length} bytes. ` +
        `If the change is intended, re-baseline with UPDATE_GOLDEN=1.`,
    );
  }
}

const TARGETS: Record<string, PrintTarget> = {
  '50x30': printTarget('m110', '50x30'),
  '62x100': printTarget('m221', '62x100'),
};

describe('LabelRendererService', () => {
  const renderer = new LabelRendererService();

  describe('geometry', () => {
    it('renders at its own head width and canvas height for every target', async () => {
      for (const target of Object.values(TARGETS)) {
        const { headWidthDots, canvasHeightDots } = geometryOf(target);
        const rows = await renderer.itemTag(
          { name: 'Skis', priceCents: 1000, sku: 'SS26-A-0001' },
          target,
        );
        expect(rows[0]).toHaveLength(headWidthDots);
        expect(rows).toHaveLength(canvasHeightDots);
      }
    });

    // The assertion whose absence let `40x30` be a size in name only: it shared
    // every number with `50x30`, so nothing could tell them apart.
    it('centres narrower media under the head, and leaves full-width media alone', () => {
      expect(geometryOf(TARGETS['50x30'])).toMatchObject({
        headWidthDots: 400, mediaWidthDots: 400, mediaOffsetDots: 0, canvasHeightDots: 224,
      });
      expect(geometryOf(TARGETS['62x100'])).toMatchObject({
        headWidthDots: 600, mediaWidthDots: 496, mediaOffsetDots: 52, canvasHeightDots: 784,
      });
    });

    it('declares the raster width it actually rendered, not a constant', () => {
      const job = renderer.toPrintJob(renderer.calibration(TARGETS['62x100']));
      const gs = job.indexOf(0x1d);
      // 75-byte head, and 800 rows with the feed — little-endian, so 0x0320.
      expect(Array.from(job.slice(gs, gs + 8))).toEqual([0x1d, 0x76, 0x30, 0x00, 75, 0, 0x20, 0x03]);
    });

    it('produces an ESC/POS job with the GS v 0 raster header', () => {
      const job = renderer.toPrintJob(renderer.calibration(TARGETS['50x30']));
      // ESC @, energy, speed, then GS v 0 with 50 bytes/row and 240 rows.
      expect(Array.from(job.slice(0, 2))).toEqual([0x1b, 0x40]);
      const gs = job.indexOf(0x1d);
      expect(Array.from(job.slice(gs, gs + 8))).toEqual([0x1d, 0x76, 0x30, 0x00, 50, 0, 240, 0]);
    });
  });

  describe('golden rasters', () => {
    it('item tag', async () => {
      expectGolden(
        'item-tag',
        await renderer.itemTag(
          { name: 'Rossignol Experience 88 Ti 172cm', priceCents: 24999, sku: 'SS26-A-0042' },
          TARGETS['50x30'],
        ),
      );
    });

    // The SKU budget is 13 characters (§6); this pins the widest barcode that fits.
    it('item tag at the 13-character SKU ceiling', async () => {
      const sku = 'ABSS26-A-0042';
      expect(sku).toHaveLength(13);
      expectGolden(
        'item-tag-max-sku',
        await renderer.itemTag({ name: 'Poles', priceCents: 500, sku }, TARGETS['50x30']),
      );
    });

    // ── The tall tier ────────────────────────────────────────────────────────

    it('tall item tag', async () => {
      expectGolden(
        'item-tag-62x100',
        await renderer.itemTag(
          { name: 'Rossignol Experience 88 Ti Skis', priceCents: 24500, sku: 'SS26-A-0042' },
          TARGETS['62x100'],
        ),
      );
    });

    it('tall item tag at the 13-character SKU ceiling', async () => {
      const sku = 'ABSS26-A-0042';
      expect(sku).toHaveLength(13);
      expectGolden(
        'item-tag-62x100-max-sku',
        await renderer.itemTag({ name: 'Poles', priceCents: 500, sku }, TARGETS['62x100']),
      );
    });

    /**
     * The failure mode only this tier has.
     *
     * The compact tag shrinks a long name until it fits one line; the tall tag
     * wraps it up a 22 mm column and has to decide what to do when it runs out
     * of lines. Nothing else in the renderer wraps, so this is the one case with
     * no precedent to lean on.
     */
    it('tall item tag wraps a long name, and ellipsises what will not fit', async () => {
      expectGolden(
        'item-tag-62x100-wrapped',
        await renderer.itemTag(
          {
            name: 'Salomon QST 106 All Mountain Freeride Skis 2024 With Bindings And A Description Nobody Would Ever Type But Somebody Will',
            priceCents: 129900,
            sku: 'SS26-K-9999',
          },
          TARGETS['62x100'],
        ),
      );
    });

    // A word with no spaces cannot be broken between words, and breaking it
    // wrongly is an infinite loop rather than an ugly label.
    it('tall item tag survives a name with nothing to break on', async () => {
      expectGolden(
        'item-tag-62x100-unbreakable',
        await renderer.itemTag(
          { name: 'Supercalifragilisticexpialidociousskisandbindingsandpoles', priceCents: 5000, sku: 'SS26-A-0007' },
          TARGETS['62x100'],
        ),
      );
    });

    // Legacy tickets are bare digits, and Code 128-B encodes those the same —
    // but they are a live path, so the tag they produce is pinned.
    it('tall item tag with a legacy ticket number', async () => {
      expectGolden(
        'item-tag-62x100-legacy',
        await renderer.itemTag(
          { name: 'Burton Custom Snowboard', priceCents: 8000, sku: '67421' },
          TARGETS['62x100'],
        ),
      );
    });

    it('item tag truncates a name too wide for the label', async () => {
      expectGolden(
        'item-tag-long-name',
        await renderer.itemTag(
          {
            name: 'An extremely long item description that cannot possibly fit on one label',
            priceCents: 9999,
            sku: 'SS26-A-0043',
          },
          TARGETS['50x30'],
        ),
      );
    });

    it('receipt header', async () => {
      expectGolden(
        'receipt-header',
        await renderer.receiptHeader(
          {
            orgLogoUrl: null,
            date: '26 Aug 2026',
            sellerName: 'Jane Doe',
            phone: '+1 555 010 1001',
            qrUrl: 'https://skiswap.patrolkit.io/s/abc123',
          },
          TARGETS['50x30'],
        ),
      );
    });

    it('calibration pattern', () => {
      expectGolden('calibration', renderer.calibration(TARGETS['50x30']));
    });
  });

  describe('receipt pagination', () => {
    it('splits an item list across as many labels as it needs', async () => {
      const items = Array.from({ length: 9 }, (_, i) => ({
        name: `Item ${i + 1}`,
        sku: `SS26-A-00${10 + i}`,
        priceCents: 1500,
      }));
      const pages = await renderer.receiptItems(items, TARGETS['50x30']);
      expect(pages.length).toBeGreaterThan(1);
      pages.forEach((p) => expect(p[0]).toHaveLength(geometryOf(TARGETS['50x30']).headWidthDots));
    });

    it('returns a single label for a short list', async () => {
      const pages = await renderer.receiptItems(
        [{ name: 'Skis', sku: 'SS26-A-0001', priceCents: 1000 }],
        TARGETS['50x30'],
      );
      expect(pages).toHaveLength(1);
    });

    it('returns nothing for no items', async () => {
      expect(await renderer.receiptItems([], TARGETS['50x30'])).toHaveLength(0);
    });
  });
});
