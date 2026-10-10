import { PrintRecipeService } from './print-recipe.service';
import { LabelRendererService } from './label-renderer.service';
import { printTarget } from './geometry';

/**
 * A legacy ticket lost or torn gets a replacement tag from the Items page:
 * the same number and barcode as its paper ticket. One not yet priced waits.
 */

function build(item: { sku: string; name: string; priceCents: number | null }) {
  const prisma = {
    swapItem: { findFirst: async () => ({ id: 'it-1', orgId: 'org-1', deletedAt: null, ...item }) },
    skiSwapSettings: { findUnique: async () => ({ barcodesPerTicket: 1 }) },
  };
  return new PrintRecipeService(prisma as never, new LabelRendererService(), { get: () => '' } as never);
}

describe('a replacement tag for a legacy ticket', () => {
  it('prints a priced ticket’s tag', async () => {
    const pages = await build({ sku: '73338', name: 'Item #73338', priceCents: 4000 })
      .resolve('org-1', { kind: 'item', itemId: 'it-1' }, printTarget('m221', '62x100'));
    expect(pages).toHaveLength(1);
    expect(pages[0].some((row) => row.some(Boolean))).toBe(true);
  });

  it('waits for an unpriced one’s price, and says so', async () => {
    await expect(build({ sku: '73338', name: 'Item #73338', priceCents: null })
      .resolve('org-1', { kind: 'item', itemId: 'it-1' }, printTarget('m221', '62x100')))
      .rejects.toThrow('Ticket 73338 has no price yet. Price it, then print its tag.');
  });
});
