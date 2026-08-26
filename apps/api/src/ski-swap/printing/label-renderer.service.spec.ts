import * as fs from 'fs';
import * as path from 'path';
import { LabelRendererService } from './label-renderer.service';
import { DEFAULT_PRINTER_MARGINS, HEAD_WIDTH_DOTS, type PrintTarget } from './geometry';

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

/** Packs a 1-bit raster the same way the ESC/POS command does: MSB first, row-major. */
function pack(rows: boolean[][]): Buffer {
  const W = rows[0].length;
  const bytesPerRow = Math.ceil(W / 8);
  const out = Buffer.alloc(rows.length * bytesPerRow);
  rows.forEach((row, y) => {
    for (let x = 0; x < W; x++) {
      if (row[x]) out[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x % 8);
    }
  });
  return out;
}

function expectGolden(name: string, rows: boolean[][]): void {
  const file = path.join(FIXTURES, `${name}.bin`);
  const actual = pack(rows);

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
  '50x30': { paperSize: '50x30', margins: DEFAULT_PRINTER_MARGINS },
  '40x30': { paperSize: '40x30', margins: DEFAULT_PRINTER_MARGINS },
};

describe('LabelRendererService', () => {
  const renderer = new LabelRendererService();

  describe('geometry', () => {
    it('renders at the full head width on both media sizes', async () => {
      for (const target of Object.values(TARGETS)) {
        const rows = await renderer.itemTag(
          { name: 'Skis', priceCents: 1000, sku: 'SS26-A-0001' },
          target,
        );
        expect(rows[0]).toHaveLength(HEAD_WIDTH_DOTS);
        expect(rows).toHaveLength(224);
      }
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
      pages.forEach((p) => expect(p[0]).toHaveLength(HEAD_WIDTH_DOTS));
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
