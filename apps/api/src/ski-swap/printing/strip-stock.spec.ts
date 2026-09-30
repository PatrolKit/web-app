import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { LabelRendererService, packRaster } from './label-renderer.service';
import { defaultSizeFor, printTarget, sizesFor } from './geometry';
import { helperPrice, type HelperLabelData } from './label-templates';
import { CreatePrinterSchema } from '../../contracts/ski-swap.contracts';

/**
 * 25 × 67 holds legacy helper labels, and nothing else (Plan 28).
 *
 * The iPad prints them over Bluetooth, or through its station's bridge. Either
 * way the stock takes helper labels only, and a helper label takes no other
 * stock.
 */

const FIXTURES = path.join(__dirname, '__fixtures__');

/** Compared byte for byte; `UPDATE_GOLDEN=1` re-baselines after an intended change. */
function golden(name: string, rows: boolean[][]): void {
  const bytes = Buffer.from(packRaster(rows));
  const file = path.join(FIXTURES, `${name}.bin`);
  if (process.env.UPDATE_GOLDEN || !fs.existsSync(file)) {
    fs.writeFileSync(file, bytes);
    return;
  }
  expect(bytes.equals(fs.readFileSync(file))).toBe(true);
}

const renderer = new LabelRendererService();
const strip = printTarget('m221', '25x67');

const STICKERS: HelperLabelData = {
  name: 'Volkl Kendo 88 skis 176cm',
  itemName: 'Volkl Kendo 88 skis',
  size: '176cm',
  priceCents: 24900,
  sellerName: 'Dana Reyes',
};

describe('25 × 67 stock', () => {
  it('is stock an M221 can be set up with, but not its default', () => {
    expect(strip.size.tier).toBe('strip');
    expect(sizesFor('m221')).toContain('25x67');
    expect(sizesFor('m110')).not.toContain('25x67');
    expect(defaultSizeFor('m221')).toBe('62x100');
    expect(CreatePrinterSchema.safeParse({
      name: 'Counter', bluetoothName: 'M221-1', model: 'm221', paperSize: '25x67',
    }).success).toBe(true);
  });

  const item = { name: 'Skis', sku: 'A-0001', priceCents: 1000, sellerName: 'Dana' } as never;
  const header = { sellerName: 'Dana', orgName: 'Stowe', swapTitle: 'Fall', qrUrl: 'https://x' } as never;
  const refused: [string, () => unknown][] = [
    ['an item tag', () => renderer.itemTag(item, strip)],
    ['a printer label', () => renderer.printerLabel('Counter', 'Stowe', strip)],
    ['a QR label', () => renderer.qrLabel('Dana', 'https://x', strip)],
    ['a receipt header', () => renderer.receiptHeader(header, strip)],
    ['a tall receipt', () => renderer.tallReceipt(header, [], strip)],
    ['receipt items, even an empty list', () => renderer.receiptItems([], strip)],
    ['a calibration label', () => renderer.calibration(strip)],
  ];

  it.each(refused)('refuses %s, saying what it holds', async (_what, render) => {
    const refusal = await Promise.resolve().then(render).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as Error).message).toMatch(/loaded with 25 × 67 helper labels, and prints nothing else/);
  });

  it('refuses helper labels on any other stock', async () => {
    for (const other of [printTarget('m221', '62x100'), printTarget('m110', '50x30')]) {
      await expect(renderer.helperLabels(STICKERS, 'A', other)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe('the helper stickers', () => {
  it('are two, item then office, each the full head wide and the stock long', async () => {
    const pages = await renderer.helperLabels(STICKERS, 'A', strip);
    expect(pages).toHaveLength(2);
    for (const rows of pages) {
      expect(rows[0]).toHaveLength(576);
      expect(rows).toHaveLength(67 * 8 - 16);
    }
  });

  it('print only on the stock, never on the head either side of it', async () => {
    const [item] = await renderer.helperLabels(STICKERS, 'A', strip);
    const outside = item.some((row) => row.some((on, c) => on && (c < 188 || c >= 388)));
    expect(outside).toBe(false);
  });

  it('write prices the way the iPad does', () => {
    expect(helperPrice(4500)).toBe('$45');
    expect(helperPrice(1999)).toBe('$19.99');
    expect(helperPrice(1205)).toBe('$12.05');
  });

  it('match the golden rasters', async () => {
    const [item, office] = await renderer.helperLabels(STICKERS, 'A', strip);
    golden('helper-item', item);
    golden('helper-office', office);
    const [noSize] = await renderer.helperLabels({ ...STICKERS, size: null }, null, strip);
    golden('helper-item-no-size', noSize);
    const long = 'Rossignol Experience 88 Ti skis with Look SPX 12 bindings';
    const [cutItem, cutOffice] = await renderer.helperLabels({ ...STICKERS, name: long, itemName: long }, 'K', strip);
    golden('helper-item-long-name', cutItem);
    golden('helper-office-long-name', cutOffice);
  });

  it('carry the station letter only when given one', async () => {
    const [withLetter] = await renderer.helperLabels(STICKERS, 'A', strip);
    const [without] = await renderer.helperLabels(STICKERS, null, strip);
    const ink = (rows: boolean[][]) => rows.flat().filter(Boolean).length;
    expect(ink(withLetter)).toBeGreaterThan(ink(without));
  });
});
