import type { PrismaService } from '../../prisma/prisma.service';
import type { CompRef } from '../sales-check';
import type { CompReason, ItemComp } from '../../contracts/comps.contracts';

/**
 * A swap's live comps (Plan 53), as `attributeSales` takes them: each with its
 * item's Square variation, which is how every reader matches a sale to an
 * item. Read fresh each time, as decisions and exchanges are, so a comp or an
 * undo shows at once.
 */
export async function liveComps(prisma: Pick<PrismaService, 'swapComp' | 'swapItem'>, swapId: string): Promise<CompRef[]> {
  const rows = await prisma.swapComp.findMany({
    where: { swapId, liveKey: { not: null } },
    select: { id: true, itemId: true, units: true, priceCents: true, compedAt: true },
  });
  if (!rows.length) return [];
  // Deleted items too: a comped sale stays a sale after its item goes.
  const items = await prisma.swapItem.findMany({ where: { id: { in: rows.map((r) => r.itemId) } }, select: { id: true, squareVariationId: true } });
  const variation = new Map(items.map((i) => [i.id, i.squareVariationId]));
  return rows.flatMap((r) => {
    const variationId = variation.get(r.itemId);
    return variationId ? [{ id: r.id, variationId, units: r.units, priceCents: r.priceCents, compedAt: r.compedAt }] : [];
  });
}

/** The live comp on each of these items, for staff item responses (Plan 53 D6). */
export async function liveCompsByItem(prisma: Pick<PrismaService, 'swapComp'>, itemIds: string[]): Promise<Map<string, ItemComp>> {
  if (!itemIds.length) return new Map();
  const rows = await prisma.swapComp.findMany({ where: { itemId: { in: itemIds }, liveKey: { not: null } }, orderBy: { compedAt: 'asc' } });
  return new Map(rows.map((r) => [r.itemId, itemComp(r)]));
}

export function itemComp(r: { id: string; priceCents: number; units: number; reason: string; note: string; compedAt: Date; compedBy: string | null }): ItemComp {
  return { id: r.id, priceCents: r.priceCents, units: r.units, reason: r.reason as CompReason, note: r.note, compedAt: r.compedAt.toISOString(), compedBy: r.compedBy };
}
