import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SquareClientService } from './square-client.service';
import { deriveSkuPrefix } from './sku.util';
import { createId } from '@paralleldrive/cuid2';
import { v4 as uuidv4 } from 'uuid';
import type { SwapResponse } from '../contracts/ski-swap.contracts';

@Injectable()
export class SwapService {
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

    const upsertRes = await client.catalog.object.upsert({
      idempotencyKey: uuidv4(),
      object: {
        type: 'CATEGORY',
        id: '#category',
        categoryData: { name: `PatrolKit/${title}` },
      },
    });

    const squareCategoryId = upsertRes.catalogObject?.id;
    if (!squareCategoryId) {
      throw new BadRequestException('Square did not return a category ID');
    }

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

    if (data.title !== undefined && data.title !== swap.title) {
      // Rename Square category — fetch current version first for optimistic locking
      const catRes = await client.catalog.object.get({ objectId: swap.squareCategoryId });
      const currentVersion = catRes.object?.version;

      await client.catalog.object.upsert({
        idempotencyKey: uuidv4(),
        object: {
          type: 'CATEGORY',
          id: swap.squareCategoryId,
          ...(currentVersion !== undefined ? { version: currentVersion } : {}),
          categoryData: { name: `PatrolKit/${data.title}` },
        },
      });

      // Re-derive prefix if title changed (keep existing if no collision)
      const newBase = deriveSkuPrefix(data.title);
      if (newBase !== swap.skuPrefix) {
        newSkuPrefix = await this.resolveUniquePrefix(orgId, newBase, swapId);
      }
    }

    const updated = await this.prisma.skiSwap.update({
      where: { id: swapId },
      data: {
        ...(data.title !== undefined ? { title: data.title, skuPrefix: newSkuPrefix } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.locationId !== undefined ? { locationId: data.locationId } : {}),
      },
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
