import { PrintRecipeService } from './print-recipe.service';
import { LabelRendererService } from './label-renderer.service';
import { printTarget } from './geometry';

/**
 * A 62 × 100 receipt is one page with its masthead built in, so its separate
 * header label is nothing. The web asks for both, header then items, and used
 * to print the masthead twice.
 */

function build() {
  const prisma = {
    sellerProfile: {
      findFirst: async () => ({
        id: 'seller-1', businessName: null,
        membership: { user: { firstName: 'Dana', lastName: 'Reyes', email: null, phone: '+18025550100' }, org: { logoUrl: null } },
      }),
    },
    swapItem: { findMany: async () => [{ name: 'Snowboard', sku: 'SS26-A-0001', priceCents: 9000 }] },
  };
  const config = { get: () => 'https://skiswap.patrolkit.io' };
  return new PrintRecipeService(prisma as never, new LabelRendererService(), config as never);
}

describe('a receipt header', () => {
  it('is nothing on 62 × 100, where the receipt carries its own', async () => {
    const recipes = build();
    const tall = printTarget('m221', '62x100');
    await expect(recipes.resolve('org-1', { kind: 'receipt_header', sellerId: 'seller-1' }, tall)).resolves.toEqual([]);
    const receipt = await recipes.resolve('org-1', { kind: 'receipt_items', sellerId: 'seller-1', swapId: 'swap-1' }, tall);
    expect(receipt).toHaveLength(1);
  });

  it('is still its own label on 50 × 30', async () => {
    const recipes = build();
    const pages = await recipes.resolve('org-1', { kind: 'receipt_header', sellerId: 'seller-1' }, printTarget('m110', '50x30'));
    expect(pages).toHaveLength(1);
  });
});
