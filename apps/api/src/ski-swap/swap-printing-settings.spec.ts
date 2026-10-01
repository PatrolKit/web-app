import { BadRequestException } from '@nestjs/common';
import { SwapService } from './swap.service';
import { SkiSwapSettingsService } from './ski-swap-settings.service';

/**
 * The swap's printing settings: how many tags an item gets, and whether the
 * iPad prints a helper label with each legacy ticket.
 *
 * The helper-label switch belongs to "legacy tickets only", the way that one
 * belongs to "legacy tickets": it is refused without it, and cleared when it
 * goes, so the iPad is never told to print helpers for a swap that is not
 * tickets-only.
 */

type Swap = {
  id: string; orgId: string; title: string; squareCategoryId: string; locationId: string;
  active: boolean; skuPrefix: string; legacyTicketsEnabled: boolean; legacyTicketsOnly: boolean;
  printLegacyHelperLabels: boolean; labelsPerItem: number; createdAt: Date; updatedAt: Date;
};

function harness(start: Partial<Swap>) {
  const swap: Swap = {
    id: 'swap-1', orgId: 'org-1', title: 'Fall', squareCategoryId: 'cat', locationId: 'loc', active: false,
    skuPrefix: 'FAL', legacyTicketsEnabled: false, legacyTicketsOnly: false, printLegacyHelperLabels: false,
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
  it('can be turned on for a swap that takes legacy tickets only', async () => {
    const { swaps } = harness({ legacyTicketsEnabled: true, legacyTicketsOnly: true });
    await expect(swaps.patch('org-1', 'swap-1', { printLegacyHelperLabels: true }))
      .resolves.toMatchObject({ printLegacyHelperLabels: true });
  });

  it('can be turned on in the same change that makes the swap tickets-only', async () => {
    const { swaps } = harness({ legacyTicketsEnabled: true });
    await expect(swaps.patch('org-1', 'swap-1', { legacyTicketsOnly: true, printLegacyHelperLabels: true }))
      .resolves.toMatchObject({ legacyTicketsOnly: true, printLegacyHelperLabels: true });
  });

  it('is refused for a swap that also prints tags', async () => {
    const { swaps } = harness({ legacyTicketsEnabled: true, legacyTicketsOnly: false });
    await expect(swaps.patch('org-1', 'swap-1', { printLegacyHelperLabels: true }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('is cleared when the swap stops being tickets-only', async () => {
    const { swaps } = harness({ legacyTicketsEnabled: true, legacyTicketsOnly: true, printLegacyHelperLabels: true });
    await expect(swaps.patch('org-1', 'swap-1', { legacyTicketsOnly: false }))
      .resolves.toMatchObject({ printLegacyHelperLabels: false });
  });

  it('is cleared when the swap stops taking legacy tickets at all', async () => {
    const { swaps } = harness({ legacyTicketsEnabled: true, legacyTicketsOnly: true, printLegacyHelperLabels: true });
    await expect(swaps.patch('org-1', 'swap-1', { legacyTicketsEnabled: false }))
      .resolves.toMatchObject({ legacyTicketsOnly: false, printLegacyHelperLabels: false });
  });

  it('survives an unrelated change', async () => {
    const { swaps } = harness({ legacyTicketsEnabled: true, legacyTicketsOnly: true, printLegacyHelperLabels: true });
    await expect(swaps.patch('org-1', 'swap-1', { labelsPerItem: 2 }))
      .resolves.toMatchObject({ printLegacyHelperLabels: true, labelsPerItem: 2 });
  });
});
