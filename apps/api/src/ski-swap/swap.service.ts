import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SquareClientService } from './square-client.service';
import { deriveSkuPrefix } from './sku.util';
import { createId } from '@paralleldrive/cuid2';
import { v4 as uuidv4 } from 'uuid';
import type { SwapResponse } from '../contracts/ski-swap.contracts';
import type { SquareClient } from 'square';

@Injectable()
export class SwapService {
  private readonly logger = new Logger(SwapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly squareClient: SquareClientService,
  ) {}

  async list(orgId: string, activeOnly?: boolean): Promise<SwapResponse[]> {
    const swaps = await this.prisma.skiSwap.findMany({
      where: { orgId, ...(activeOnly ? { active: true } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return swaps.map(this.toResponse);
  }

  async get(orgId: string, swapId: string): Promise<SwapResponse> {
    const swap = await this.findOrThrow(orgId, swapId);
    return this.toResponse(swap);
  }

  async create(
    orgId: string,
    title: string,
    locationId: string,
    actorId: string,
  ): Promise<SwapResponse> {
    const client = await this.squareClient.forOrg(orgId);

    const basePrefix = deriveSkuPrefix(title);
    const skuPrefix = await this.resolveUniquePrefix(orgId, basePrefix);

    const parentCategoryId = await this.findOrCreatePatrolKitCategory(client);
    const squareCategoryId = await this.findOrCreateSwapCategory(client, parentCategoryId, title);

    const swap = await this.prisma.skiSwap.create({
      data: {
        id: createId(),
        orgId,
        title,
        squareCategoryId,
        locationId,
        active: false,
        skuPrefix,
        createdBy: actorId,
      },
    });

    return this.toResponse(swap);
  }

  async patch(
    orgId: string,
    swapId: string,
    data: { title?: string; active?: boolean; locationId?: string },
  ): Promise<SwapResponse> {
    const swap = await this.findOrThrow(orgId, swapId);
    const client = await this.squareClient.forOrg(orgId);

    let newSkuPrefix = swap.skuPrefix;
    let squareCategoryId = swap.squareCategoryId;

    if (data.title !== undefined && data.title !== swap.title) {
      const parentCategoryId = await this.findOrCreatePatrolKitCategory(client);

      // The version is Square's optimistic lock, and fetching it is also how we
      // find out the category is still there. Anyone may delete one from the
      // Square dashboard — tidying duplicates is the obvious way to end up
      // here — and a swap whose category has gone was left permanently
      // unrenameable, the 404 surfacing as a bare "Internal server error".
      const current = await client.catalog.object
        .get({ objectId: squareCategoryId })
        .catch(() => null);

      if (current?.object) {
        await client.catalog.object.upsert({
          idempotencyKey: uuidv4(),
          object: {
            type: 'CATEGORY',
            id: squareCategoryId,
            ...(current.object.version !== undefined ? { version: current.object.version } : {}),
            categoryData: { name: data.title, parentCategory: { id: parentCategoryId } },
          },
        });
      } else {
        // Gone. Adopt or create one under the new name and remember it, the
        // same recovery the item sync already performs when Square resolves a
        // category other than the one we held.
        this.logger.warn(
          { swapId, squareCategoryId },
          'Square category is missing; creating a replacement for the renamed swap',
        );
        squareCategoryId = await this.findOrCreateSwapCategory(client, parentCategoryId, data.title);
      }

      // Re-derive prefix if title changed (keep existing if no collision)
      const newBase = deriveSkuPrefix(data.title);
      if (newBase !== swap.skuPrefix) {
        newSkuPrefix = await this.resolveUniquePrefix(orgId, newBase, swapId);
      }
    }

    // `activeSkuPrefix` mirrors `skuPrefix` only while the swap is live. MySQL
    // permits many NULLs in a unique index, so inactive swaps never collide —
    // which is what stops two running swaps minting the same SKU. Recomputed on
    // every patch because either half of the pair can move: activating a swap,
    // or renaming one that is already active.
    const willBeActive = data.active !== undefined ? data.active : swap.active;

    const updated = await this.prisma.skiSwap
      .update({
        where: { id: swapId },
        data: {
          ...(data.title !== undefined
            ? { title: data.title, skuPrefix: newSkuPrefix, squareCategoryId }
            : {}),
          ...(data.active !== undefined ? { active: data.active } : {}),
          ...(data.locationId !== undefined ? { locationId: data.locationId } : {}),
          activeSkuPrefix: willBeActive ? newSkuPrefix : null,
        },
      })
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `Another running swap already issues "${newSkuPrefix}" SKUs. Rename one, or close the other first.`,
          );
        }
        throw err;
      });

    return this.toResponse(updated);
  }

  async remove(orgId: string, swapId: string): Promise<void> {
    const swap = await this.findOrThrow(orgId, swapId);
    const itemCount = await this.prisma.swapItem.count({ where: { swapId: swap.id } });
    if (itemCount > 0) {
      throw new ConflictException(
        'Cannot delete a swap that has item mappings. Remove all items first.',
      );
    }
    await this.prisma.skiSwap.delete({ where: { id: swapId } });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async findOrThrow(orgId: string, swapId: string) {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId } });
    if (!swap) throw new NotFoundException('Swap not found');
    return swap;
  }

  /**
   * Returns a prefix that doesn't already exist for this org.
   * If base collides, appends B, C, D, … Z, then falls back to base+timestamp.
   * Excludes `excludeSwapId` (used on rename so the swap doesn't collide with itself).
   */
  private async resolveUniquePrefix(
    orgId: string,
    base: string,
    excludeSwapId?: string,
  ): Promise<string> {
    const SUFFIXES = 'BCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const candidates = [base, ...SUFFIXES.map((s) => `${base}${s}`.slice(0, 6))];

    for (const candidate of candidates) {
      const existing = await this.prisma.skiSwap.findFirst({
        where: { orgId, skuPrefix: candidate, ...(excludeSwapId ? { id: { not: excludeSwapId } } : {}) },
      });
      if (!existing) return candidate;
    }
    // Fallback: truncated timestamp suffix
    return `${base.slice(0, 4)}${Date.now().toString().slice(-2)}`;
  }

  /**
   * The Square category a swap's items are filed under, reused if it is there.
   *
   * Upserting with a fresh `#category` id and a new idempotency key is a
   * create, every time — which is what this used to do, so re-creating a swap
   * left the catalogue holding one category per attempt, all with the same
   * name and no way to tell them apart.
   *
   * Matched within the PatrolKit parent rather than by name across the whole
   * catalogue: a shop may well already have a category called after the season,
   * and adopting one that is not ours would file consigned items into it.
   */
  private async findOrCreateSwapCategory(
    client: SquareClient,
    parentCategoryId: string,
    title: string,
  ): Promise<string> {
    const page = await client.catalog.list({ types: 'CATEGORY' });
    for await (const obj of page) {
      if (obj.type !== 'CATEGORY') continue;
      const data = (obj as { categoryData?: { name?: string; parentCategory?: { id?: string } } })
        .categoryData;
      if (data?.name === title && data.parentCategory?.id === parentCategoryId) {
        return obj.id as string;
      }
    }

    const res = await client.catalog.object.upsert({
      idempotencyKey: uuidv4(),
      object: {
        type: 'CATEGORY',
        id: '#category',
        categoryData: { name: title, parentCategory: { id: parentCategoryId } },
      },
    });
    const id = res.catalogObject?.id;
    if (!id) throw new BadRequestException('Square did not return a category ID');
    return id;
  }

  private async findOrCreatePatrolKitCategory(client: SquareClient): Promise<string> {
    const page = await client.catalog.list({ types: 'CATEGORY' });
    for await (const obj of page) {
      if (obj.type === 'CATEGORY' && (obj as any).categoryData?.name === 'PatrolKit') {
        return obj.id as string;
      }
    }
    const res = await client.catalog.object.upsert({
      idempotencyKey: uuidv4(),
      object: {
        type: 'CATEGORY',
        id: '#patrolkit',
        categoryData: { name: 'PatrolKit', isTopLevel: true },
      },
    });
    const id = res.catalogObject?.id;
    if (!id) throw new Error('Square did not return a category ID for PatrolKit');
    return id;
  }

  private toResponse(swap: {
    id: string;
    orgId: string;
    title: string;
    squareCategoryId: string;
    locationId: string;
    active: boolean;
    skuPrefix: string;
    createdAt: Date;
    updatedAt: Date;
  }): SwapResponse {
    return {
      id: swap.id,
      orgId: swap.orgId,
      title: swap.title,
      squareCategoryId: swap.squareCategoryId,
      locationId: swap.locationId,
      active: swap.active,
      skuPrefix: swap.skuPrefix,
      createdAt: swap.createdAt.toISOString(),
      updatedAt: swap.updatedAt.toISOString(),
    };
  }
}

/** A collision on the (orgId, activeSkuPrefix) index — two live swaps, one prefix. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
