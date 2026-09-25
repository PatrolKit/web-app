import { BadRequestException } from '@nestjs/common';
import { LabelRendererService } from './label-renderer.service';
import { defaultSizeFor, printTarget, sizesFor } from './geometry';
import { CreatePrinterSchema } from '../../contracts/ski-swap.contracts';

/**
 * 25 × 67 is the iPad's stock. It prints to it directly over Bluetooth; the
 * server only has to let a printer be set up with it, and must refuse to draw
 * anything on it rather than print a layout meant for other stock.
 */
describe('25 × 67, the iPad-only stock', () => {
  const renderer = new LabelRendererService();
  const target = printTarget('m221', '25x67');

  it('is stock an M221 can be set up with', () => {
    expect(target.size.id).toBe('25x67');
    expect(sizesFor('m221')).toContain('25x67');
    expect(sizesFor('m110')).not.toContain('25x67');
    expect(CreatePrinterSchema.safeParse({
      name: 'Counter', bluetoothName: 'M221-1', model: 'm221', paperSize: '25x67',
    }).success).toBe(true);
  });

  it('does not become the M221’s default, which has to be stock the server can render', () => {
    expect(defaultSizeFor('m221')).toBe('62x100');
  });

  const item = { name: 'Skis', sku: 'A-0001', priceCents: 1000, sellerName: 'Dana' } as never;
  const header = { sellerName: 'Dana', orgName: 'Stowe', swapTitle: 'Fall', qrUrl: 'https://x' } as never;
  const renders: [string, () => unknown][] = [
    ['an item tag', () => renderer.itemTag(item, target)],
    ['a printer label', () => renderer.printerLabel('Counter', 'Stowe', target)],
    ['a QR label', () => renderer.qrLabel('Dana', 'https://x', target)],
    ['a receipt header', () => renderer.receiptHeader(header, target)],
    ['a tall receipt', () => renderer.tallReceipt(header, [], target)],
    ['receipt items, even an empty list', () => renderer.receiptItems([], target)],
    ['a calibration label', () => renderer.calibration(target)],
  ];

  it.each(renders)('refuses to draw %s on it, saying why', async (_what, render) => {
    const refusal = await Promise.resolve().then(render).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as Error).message).toMatch(/25 × 67 mm labels are printed from the iPad only/);
  });
});
