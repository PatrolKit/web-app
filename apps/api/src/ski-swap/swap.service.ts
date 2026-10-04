import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SquareClientService } from './square-client.service';
import { deriveSkuPrefix, deriveSwapSlug } from './sku.util';
import { assertReceiptSettings, sanitizeFinePrint, type ReceiptSettings } from './receipt-settings';
import { isUniqueViolation } from '../common/util/prisma-errors';
import { createId } from '@paralleldrive/cuid2';
import { v4 as uuidv4 } from 'uuid';
import type { SwapResponse } from '../contracts/ski-swap.contracts';
import { DEFAULT_SWAP_TIME_ZONE } from './swap-time-zone';
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
    extras: {
      slug?: string; timeZone?: string;
      skuLookupEnabled?: boolean; sellerLookupEnabled?: boolean; sellerLoginEnabled?: boolean;
    } & Partial<ReceiptSettings> = {},
  ): Promise<SwapResponse> {
    const receipt = receiptSettingsAfter(DEFAULT_RECEIPT_SETTINGS, extras);
    const client = await this.squareOrExplain(orgId, 'creating a swap');

    // A slug someone typed is theirs or refused; a derived one is made unique.
    if (extras.slug) await this.assertSlugFree(orgId, extras.slug);
    const slug = extras.slug ?? (await this.resolveUniqueSlug(orgId, deriveSwapSlug(title)));

    const basePrefix = deriveSkuPrefix(title);
    const skuPrefix = await this.resolveUniquePrefix(orgId, basePrefix);

    const parentCategoryId = await this.findOrCreatePatrolKitCategory(client);
    const squareCategoryId = await this.findOrCreateSwapCategory(client, parentCategoryId, title);

    // A new swap prints as many tags as the org's last one did, until somebody
    // says otherwise: a patrol that tags skis at both ends does it every year.
    const previous = await this.prisma.skiSwap.findFirst({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      select: { labelsPerItem: true },
    });

    const swap = await this.prisma.skiSwap.create({
      data: {
        id: createId(),
        orgId,
        title,
        squareCategoryId,
        locationId,
        active: false,
        skuPrefix,
        slug,
        timeZone: extras.timeZone ?? DEFAULT_SWAP_TIME_ZONE,
        skuLookupEnabled: extras.skuLookupEnabled ?? false,
        sellerLookupEnabled: extras.sellerLookupEnabled ?? false,
        sellerLoginEnabled: extras.sellerLoginEnabled ?? false,
        ...receipt,
        labelsPerItem: previous?.labelsPerItem ?? 1,
        createdBy: actorId,
      },
    }).catch((err: unknown) => {
      // Two creates racing for one derived slug.
      if (isUniqueViolation(err) && uniqueTarget(err).includes('slug')) {
        throw new ConflictException(`Another swap already uses the slug "${slug}".`);
      }
      throw err;
    });

    return this.toResponse(swap);
  }

  async patch(
    orgId: string,
    swapId: string,
    data: {
      title?: string; active?: boolean; locationId?: string;
      allowLegacyCheckin?: boolean; allowLegacyWeb?: boolean; allowPrintCheckin?: boolean; allowPrintWeb?: boolean;
      printLegacyHelperLabels?: boolean; labelsPerItem?: number;
      slug?: string; timeZone?: string;
      skuLookupEnabled?: boolean; sellerLookupEnabled?: boolean; sellerLoginEnabled?: boolean;
    } & Partial<ReceiptSettings>,
  ): Promise<SwapResponse> {
    const swap = await this.findOrThrow(orgId, swapId);
    // Judged as they'll stand after this write (Plan 36).
    const receipt = receiptSettingsAfter(swap, data);
    if (data.slug !== undefined && data.slug !== swap.slug) await this.assertSlugFree(orgId, data.slug, swapId);

    // How items come in once this patch lands (Plan 34). Each place takes at
    // least one way: a place that takes neither has no way to add an item.
    const legacyCheckin = data.allowLegacyCheckin ?? swap.allowLegacyCheckin;
    const printCheckin = data.allowPrintCheckin ?? swap.allowPrintCheckin;
    const legacyWeb = data.allowLegacyWeb ?? swap.allowLegacyWeb;
    const printWeb = data.allowPrintWeb ?? swap.allowPrintWeb;
    if (!legacyCheckin && !printCheckin) {
      throw new BadRequestException('Staff check-in needs legacy tickets, print tickets, or both.');
    }
    if (!legacyWeb && !printWeb) {
      throw new BadRequestException('The web needs legacy tickets, print tickets, or both.');
    }
    if (data.printLegacyHelperLabels === true && !legacyCheckin) {
      throw new BadRequestException('Helper labels go with legacy tickets at staff check-in, which this swap doesn’t take.');
    }

    let newSkuPrefix = swap.skuPrefix;
    let squareCategoryId = swap.squareCategoryId;

    if (data.title !== undefined && data.title !== swap.title) {
      // Square is reached for only when the title moves, which is the one
      // change it has to hear about — the category is named after the swap.
      // Asking for a client up front made every patch depend on Square, so
      // flipping a boolean failed with "Connect Square before changing a swap"
      // whenever it was down, and cost a round trip when it was not.
      const client = await this.squareOrExplain(orgId, 'renaming a swap');
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
          ...(data.allowLegacyCheckin !== undefined ? { allowLegacyCheckin: data.allowLegacyCheckin } : {}),
          ...(data.allowLegacyWeb !== undefined ? { allowLegacyWeb: data.allowLegacyWeb } : {}),
          ...(data.allowPrintCheckin !== undefined ? { allowPrintCheckin: data.allowPrintCheckin } : {}),
          ...(data.allowPrintWeb !== undefined ? { allowPrintWeb: data.allowPrintWeb } : {}),
          // Helper labels can't outlive legacy tickets at check-in: cleared
          // here rather than left as a contradiction the iPad has to ignore.
          ...(!legacyCheckin
            ? { printLegacyHelperLabels: false }
            : data.printLegacyHelperLabels !== undefined
              ? { printLegacyHelperLabels: data.printLegacyHelperLabels }
              : {}),
          ...(data.labelsPerItem !== undefined ? { labelsPerItem: data.labelsPerItem } : {}),
          // The slug moves only when asked; a rename leaves it (Plan 33).
          ...(data.slug !== undefined ? { slug: data.slug } : {}),
          ...(data.timeZone !== undefined ? { timeZone: data.timeZone } : {}),
          ...(data.skuLookupEnabled !== undefined ? { skuLookupEnabled: data.skuLookupEnabled } : {}),
          ...(data.sellerLookupEnabled !== undefined ? { sellerLookupEnabled: data.sellerLookupEnabled } : {}),
          ...(data.sellerLoginEnabled !== undefined ? { sellerLoginEnabled: data.sellerLoginEnabled } : {}),
          ...receipt,
          activeSkuPrefix: willBeActive ? newSkuPrefix : null,
        },
      })
      .catch((err: unknown) => {
        // Two saves racing for one slug.
        if (isUniqueViolation(err) && uniqueTarget(err).includes('slug')) {
          throw new ConflictException(`Another swap already uses the slug "${data.slug}".`);
        }
        // A collision on the (orgId, activeSkuPrefix) index — two live swaps,
        // one prefix.
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
    const itemCount = await this.prisma.swapItem.count({ where: { swapId: swap.id, deletedAt: null } });
    if (itemCount > 0) {
      throw new ConflictException(
        'Cannot delete a swap that has item mappings. Remove all items first.',
      );
    }
    await this.prisma.skiSwap.delete({ where: { id: swapId } });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * The Square client, with a refusal that says what the caller was doing.
   *
   * A swap files its items under a Square catalogue category, so it genuinely
   * cannot be created or renamed without a connection — unlike everything
   * downstream of it, which skips Square rather than failing. That asymmetry
   * reads as a bug from outside: `forOrg` says only that Square is not
   * configured, and a client left holding that from a swap-creation call has to
   * go and read this file to find out why. It cost the iPad team an hour.
   */
  private async squareOrExplain(orgId: string, attempt: string) {
    try {
      return await this.squareClient.forOrg(orgId);
    } catch (err) {
      if (
        err instanceof ServiceUnavailableException &&
        (err.getResponse() as { code?: string }).code === 'SQUARE_NOT_CONFIGURED'
      ) {
        throw new ServiceUnavailableException({
          message: `Connect Square before ${attempt} — the swap needs a catalog category to file its items under.`,
          code: 'SQUARE_NOT_CONFIGURED',
        });
      }
      throw err;
    }
  }

  private async findOrThrow(orgId: string, swapId: string) {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId } });
    if (!swap) throw new NotFoundException('Swap not found');
    return swap;
  }

  /**
   * A slug no other swap of the org has, active or not: `base`, then `base-2`,
   * `base-3`… Not sliced, so a suffix can't fold back onto the base the way a
   * 6-character prefix's can.
   */
  private async resolveUniqueSlug(orgId: string, base: string): Promise<string> {
    const taken = new Set(
      (await this.prisma.skiSwap.findMany({
        where: { orgId, slug: { startsWith: base } },
        select: { slug: true },
      })).map((s) => s.slug),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    }
  }

  /** Refuses a slug another swap of the org already has, naming that swap. */
  private async assertSlugFree(orgId: string, slug: string, excludeSwapId?: string): Promise<void> {
    const other = await this.prisma.skiSwap.findFirst({
      where: { orgId, slug, ...(excludeSwapId ? { id: { not: excludeSwapId } } : {}) },
      select: { title: true },
    });
    if (other) throw new ConflictException(`"${other.title}" already uses the slug "${slug}".`);
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
    allowLegacyCheckin: boolean;
    allowLegacyWeb: boolean;
    allowPrintCheckin: boolean;
    allowPrintWeb: boolean;
    printLegacyHelperLabels: boolean;
    labelsPerItem: number;
    slug: string;
    skuLookupEnabled: boolean;
    sellerLookupEnabled: boolean;
    sellerLoginEnabled: boolean;
    timeZone: string;
    createdAt: Date;
    updatedAt: Date;
  } & ReceiptSettings): SwapResponse {
    return {
      id: swap.id,
      orgId: swap.orgId,
      title: swap.title,
      squareCategoryId: swap.squareCategoryId,
      locationId: swap.locationId,
      active: swap.active,
      skuPrefix: swap.skuPrefix,
      allowLegacyCheckin: swap.allowLegacyCheckin,
      allowPrintCheckin: swap.allowPrintCheckin,
      allowLegacyWeb: swap.allowLegacyWeb,
      allowPrintWeb: swap.allowPrintWeb,
      printLegacyHelperLabels: swap.printLegacyHelperLabels,
      labelsPerItem: swap.labelsPerItem,
      slug: swap.slug,
      skuLookupEnabled: swap.skuLookupEnabled,
      sellerLookupEnabled: swap.sellerLookupEnabled,
      sellerLoginEnabled: swap.sellerLoginEnabled,
      timeZone: swap.timeZone,
      receiptMode: swap.receiptMode as SwapResponse['receiptMode'],
      receiptShowSku: swap.receiptShowSku,
      receiptShowName: swap.receiptShowName,
      receiptShowPrice: swap.receiptShowPrice,
      receiptLink: swap.receiptLink as SwapResponse['receiptLink'],
      receiptPrintEnabled: swap.receiptPrintEnabled,
      receiptPaperSize: swap.receiptPaperSize as SwapResponse['receiptPaperSize'],
      receiptFinePrintEnabled: swap.receiptFinePrintEnabled,
      receiptFinePrint: swap.receiptFinePrint,
      createdAt: swap.createdAt.toISOString(),
      updatedAt: swap.updatedAt.toISOString(),
    };
  }
}

/** Which unique index a P2002 hit, as Prisma reports it on MySQL. */
function uniqueTarget(err: unknown): string {
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  return Array.isArray(target) ? target.join(',') : String(target ?? '');
}

/** A new swap's receipt settings (Plan 36 D9). */
const DEFAULT_RECEIPT_SETTINGS: ReceiptSettings = {
  receiptMode: 'ITEMIZED', receiptShowSku: true, receiptShowName: true, receiptShowPrice: true,
  receiptLink: 'NONE', receiptPrintEnabled: true, receiptPaperSize: '62x100',
  receiptFinePrintEnabled: false, receiptFinePrint: null,
};

/**
 * The receipt settings once a write lands: the current ones, overlaid with
 * what was sent, fine print sanitized. Refused if they can't make a receipt.
 */
function receiptSettingsAfter(current: ReceiptSettings, sent: Partial<ReceiptSettings>): ReceiptSettings {
  const next: ReceiptSettings = { ...pickReceiptSettings(current) };
  for (const key of Object.keys(DEFAULT_RECEIPT_SETTINGS) as (keyof ReceiptSettings)[]) {
    if (sent[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = sent[key];
  }
  if (sent.receiptFinePrint !== undefined) {
    next.receiptFinePrint = sent.receiptFinePrint === null ? null : sanitizeFinePrint(sent.receiptFinePrint) || null;
  }
  assertReceiptSettings(next);
  return next;
}

function pickReceiptSettings(s: ReceiptSettings): ReceiptSettings {
  return {
    receiptMode: s.receiptMode, receiptShowSku: s.receiptShowSku, receiptShowName: s.receiptShowName,
    receiptShowPrice: s.receiptShowPrice, receiptLink: s.receiptLink, receiptPrintEnabled: s.receiptPrintEnabled,
    receiptPaperSize: s.receiptPaperSize, receiptFinePrintEnabled: s.receiptFinePrintEnabled,
    receiptFinePrint: s.receiptFinePrint,
  };
}
