import { BadRequestException } from '@nestjs/common';
import { SwapService } from './swap.service';
import { SkiSwapSettingsService } from './ski-swap-settings.service';

/**
 * The swap's printing settings: how many tags an item gets, and whether the
 * iPad prints a helper label with each legacy ticket.
 *
 * The helper-label switch belongs to legacy tickets at staff check-in (Plan
 * 34): it is refused without them, and cleared when they go, so the iPad is
 * never told to print helpers for tickets it doesn't take.
 */

type Swap = {
  id: string; orgId: string; title: string; squareCategoryId: string; locationId: string;
  active: boolean; skuPrefix: string; allowLegacyCheckin: boolean; allowLegacyWeb: boolean;
  allowPrintCheckin: boolean; allowPrintWeb: boolean; printLegacyHelperLabels: boolean; labelsPerItem: number; createdAt: Date; updatedAt: Date;
};

function harness(start: Partial<Swap>) {
  const swap: Swap = {
    id: 'swap-1', orgId: 'org-1', title: 'Fall', squareCategoryId: 'cat', locationId: 'loc', active: false,
    skuPrefix: 'FAL', allowLegacyCheckin: false, allowLegacyWeb: false, allowPrintCheckin: true, allowPrintWeb: true, printLegacyHelperLabels: false,
    labelsPerItem: 1, createdAt: new Date(), updatedAt: new Date(), ...start,
  };
  const prisma = {
    skiSwap: {
      findFirst: async () => swap,
      update: async ({ data }: { data: Partial<Swap> }) => {
        const { activeSkuPrefix: _, ...rest } = data as Partial<Swap> & { activeSkuPrefix?: string | null };
        Object.assign(swap, rest);
        return swap;
      },
    },
  };
  return { swaps: new SwapService(prisma as never, {} as never), swap };
}

describe('labels per item, on the swap', () => {
  it('is set on the swap, and sent back with it', async () => {
    const { swaps } = harness({});
    await expect(swaps.patch('org-1', 'swap-1', { labelsPerItem: 3 })).resolves.toMatchObject({ labelsPerItem: 3 });
  });

  it('is still answered in the org settings, as the running swap’s, for iPads that read it there', async () => {
    const prisma = {
      skiSwapSettings: { findUnique: async () => null },
      skiSwap: {
        findFirst: async ({ where }: { where: { active?: boolean } }) =>
          where.active ? { labelsPerItem: 2 } : { labelsPerItem: 3 },
      },
    };
    const settings = new SkiSwapSettingsService(prisma as never, { smsEnabled: async () => false } as never);
    await expect(settings.get('org-1')).resolves.toMatchObject({ labelsPerItem: 2 });
  });
});

describe('legacy helper labels', () => {
  it('can be turned on for a swap that takes legacy tickets at staff check-in', async () => {
    const { swaps } = harness({ allowLegacyCheckin: true });
    await expect(swaps.patch('org-1', 'swap-1', { printLegacyHelperLabels: true }))
      .resolves.toMatchObject({ printLegacyHelperLabels: true });
  });

  it('can be turned on in the same change that takes legacy tickets at check-in', async () => {
    const { swaps } = harness({});
    await expect(swaps.patch('org-1', 'swap-1', { allowLegacyCheckin: true, printLegacyHelperLabels: true }))
      .resolves.toMatchObject({ allowLegacyCheckin: true, printLegacyHelperLabels: true });
  });

  it('works beside print tickets at check-in, too', async () => {
    const { swaps } = harness({ allowLegacyCheckin: true, allowPrintCheckin: true });
    await expect(swaps.patch('org-1', 'swap-1', { printLegacyHelperLabels: true }))
      .resolves.toMatchObject({ printLegacyHelperLabels: true });
  });

  it('is refused for a swap that takes no legacy tickets at check-in', async () => {
    const { swaps } = harness({ allowLegacyWeb: true });
    await expect(swaps.patch('org-1', 'swap-1', { printLegacyHelperLabels: true }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('is cleared when check-in stops taking legacy tickets', async () => {
    const { swaps } = harness({ allowLegacyCheckin: true, printLegacyHelperLabels: true });
    await expect(swaps.patch('org-1', 'swap-1', { allowLegacyCheckin: false }))
      .resolves.toMatchObject({ printLegacyHelperLabels: false });
  });

  it('survives an unrelated change', async () => {
    const { swaps } = harness({ allowLegacyCheckin: true, printLegacyHelperLabels: true });
    await expect(swaps.patch('org-1', 'swap-1', { labelsPerItem: 2 }))
      .resolves.toMatchObject({ printLegacyHelperLabels: true, labelsPerItem: 2 });
  });
});
