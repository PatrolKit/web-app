import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { TaxonomyService } from './taxonomy/taxonomy.service';
import { ItemService } from './item.service';
import { SELLER_NAME_INCLUDE, sellerDisplayName } from './seller.service';
import type {
  CategorizeAnswer,
  CategorizeItemResult,
  CategorizeItemsResponse,
  UncategorizeItemResponse,
} from '../contracts/ski-swap.contracts';

/**
 * Batch set category (Plan 45): give scanned items with no category one
 * category and its details, and nothing else.
 *
 * Its own write, not `ItemService.patch`, because a patch that changes the
 * category re-derives the name, and here the name stays unless the batch
 * asks to rename (D14). An item that already has a category is skipped,
 * never overwritten, including one categorized while the batch was on its
 * way (D10).
 */

type AnswerRow = { attributeId: string; valueId: string | null; numberValue: number | null };

@Injectable()
export class ItemCategorizeService {
  private readonly logger = new Logger(ItemCategorizeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly items: ItemService,
  ) {}

  async categorize(
    orgId: string,
    swapId: string,
    input: { categoryId: string; attributes: CategorizeAnswer[]; rename: boolean; skus: string[] },
    actorId: string,
  ): Promise<CategorizeItemsResponse> {
    await this.assertSwap(orgId, swapId);
    // The pick, checked once for the whole batch. Invalid (a value retired
    // mid-session, a question not under this category) fails every scan in
    // it, with the resolver's sentence.
    const described = await this.taxonomy.resolveAnswers(orgId, input.categoryId, input.attributes, actorId);

    const skus = [...new Set(input.skus.map((s) => s.trim()))];
    const found = await this.prisma.swapItem.findMany({
      where: { orgId, swapId, liveSku: { in: skus }, deletedAt: null },
      select: {
        id: true, liveSku: true, name: true, categoryId: true, squareItemId: true,
        category: { select: { label: true } },
        seller: { include: SELLER_NAME_INCLUDE },
      },
    });
    const bySku = new Map(found.map((i) => [i.liveSku!, i]));

    const results: CategorizeItemResult[] = [];
    const set: { id: string; sku: string; previousName: string | null }[] = [];
    for (const sku of skus) {
      const item = bySku.get(sku);
      if (!item) {
        results.push({ sku, outcome: 'not_found' });
        continue;
      }
      const base = { id: item.id, sellerName: sellerDisplayName(item.seller) };
      if (item.categoryId) {
        results.push({ sku, outcome: 'skipped', item: { ...base, name: item.name, previousName: null, categoryLabel: item.category?.label ?? null } });
        continue;
      }
      const renamed = input.rename && described.name !== item.name;
      // Conditional: someone else may have categorized it since it was read.
      const won = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.swapItem.updateMany({
          where: { id: item.id, categoryId: null, deletedAt: null },
          data: { categoryId: described.categoryId, ...(renamed ? { name: described.name } : {}) },
        });
        if (count === 0) return false;
        if (described.rows.length) {
          await tx.swapItemAttribute.createMany({ data: described.rows.map((r) => ({ id: createId(), itemId: item.id, ...r })) });
        }
        return true;
      });
      if (!won) {
        const now = await this.prisma.swapItem.findFirst({ where: { id: item.id, deletedAt: null }, select: { name: true, category: { select: { label: true } } } });
        results.push({ sku, outcome: 'skipped', item: { ...base, name: now?.name ?? item.name, previousName: null, categoryLabel: now?.category?.label ?? null } });
        continue;
      }
      set.push({ id: item.id, sku, previousName: renamed ? item.name : null });
      results.push({
        sku,
        outcome: 'set',
        item: { ...base, name: renamed ? described.name : item.name, previousName: renamed ? item.name : null, categoryLabel: described.categoryLabel },
      });
      // Square shows the name at the register: a renamed item goes again.
      // After the write and not awaited, as on any save; a failure is logged
      // and Diagnostics raises the difference (D14).
      if (renamed && item.squareItemId) {
        void this.items.syncToPos(orgId, swapId, item.id).catch((err: unknown) =>
          this.logger.error({ err, itemId: item.id }, 'Renamed item not pushed to Square'));
      }
    }

    if (set.length) {
      await this.prisma.auditLog.create({
        data: {
          actorType: 'user', actorId, orgId,
          action: 'ski_swap.items.categorized',
          targetType: 'swap', targetId: swapId,
          metadata: {
            categoryId: described.categoryId,
            attributes: described.rows,
            rename: input.rename,
            items: set.map((s) => ({ id: s.id, sku: s.sku, ...(s.previousName !== null ? { previousName: s.previousName } : {}) })),
          } as object,
        },
      });
    }
    return { results };
  }

  /**
   * Undo one row (D9): clears the category and answers this session set,
   * only while they're still exactly that, and with a rename puts the old
   * name back if the name is still the one it gave.
   */
  async uncategorize(
    orgId: string,
    swapId: string,
    itemId: string,
    expected: { categoryId: string; attributes: CategorizeAnswer[]; rename?: { from: string; to: string } },
    actorId: string,
  ): Promise<UncategorizeItemResponse> {
    const item = await this.prisma.swapItem.findFirst({
      where: { id: itemId, orgId, swapId, deletedAt: null },
      select: { id: true, name: true, categoryId: true, squareItemId: true, attributes: { select: { attributeId: true, valueId: true, numberValue: true } } },
    });
    if (!item) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'No item has this id in this swap.' });
    const want = expected.attributes.map((a) => ({ attributeId: a.attributeId, valueId: a.valueId ?? null, numberValue: a.numberValue ?? null }));
    if (item.categoryId !== expected.categoryId || !sameAnswers(item.attributes, want)) {
      throw new ConflictException({ code: 'CHANGED_SINCE', message: 'Changed since: edit it instead.' });
    }
    const restore = !!expected.rename && item.name === expected.rename.to;
    const done = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.swapItem.updateMany({
        where: { id: item.id, categoryId: expected.categoryId, deletedAt: null },
        data: { categoryId: null, ...(restore ? { name: expected.rename!.from } : {}) },
      });
      if (count === 0) return false;
      await tx.swapItemAttribute.deleteMany({ where: { itemId: item.id } });
      return true;
    });
    if (!done) throw new ConflictException({ code: 'CHANGED_SINCE', message: 'Changed since: edit it instead.' });

    await this.prisma.auditLog.create({
      data: {
        actorType: 'user', actorId, orgId,
        action: 'ski_swap.item.category_cleared',
        targetType: 'swap_item', targetId: item.id,
        metadata: { categoryId: expected.categoryId, attributes: want, ...(restore ? { nameRestoredTo: expected.rename!.from } : {}) } as object,
      },
    });
    if (restore && item.squareItemId) {
      void this.items.syncToPos(orgId, swapId, item.id).catch((err: unknown) =>
        this.logger.error({ err, itemId: item.id }, 'Restored name not pushed to Square'));
    }
    return { nameRestored: restore, name: restore ? expected.rename!.from : item.name };
  }

  private async assertSwap(orgId: string, swapId: string): Promise<void> {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { id: true } });
    if (!swap) throw new NotFoundException('Swap not found');
  }
}

/** The same answers, in any order. */
export function sameAnswers(a: AnswerRow[], b: AnswerRow[]): boolean {
  const key = (r: AnswerRow) => `${r.attributeId}|${r.valueId ?? ''}|${r.numberValue ?? ''}`;
  if (a.length !== b.length) return false;
  const want = new Set(b.map(key));
  return a.every((r) => want.has(key(r)));
}
