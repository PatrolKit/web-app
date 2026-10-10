import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { LabelRendererService } from './label-renderer.service';
import { DEFAULT_TARGET, printTarget, type PrintTarget } from './geometry';
import { displayName } from '../../common/util/person';
import { receiptLayout, receiptPrintRefusal, type ReceiptLayout } from '../receipt-layout';
import { DEFAULT_SWAP_TIME_ZONE, swapTimeText } from '../swap-time-zone';
import type { ReceiptHeaderData } from './label-templates';
import { barcodesOf } from '../ski-swap-settings.service';

/** The two lines beside a receipt's QR, per what it opens (Plan 36). */
const QR_CAPTIONS: Record<NonNullable<ReceiptLayout['link']>['kind'], [string, string]> = {
  SKU_LOOKUP: ['Scan to check', 'an item:'],
  SELLER_STATUS: ['Scan to track', 'your items:'],
  SELLER_LOGIN: ['Scan to sign in', 'and see your items:'],
};

export type PrintRecipeKind =
  | 'item'
  | 'receipt_header'
  | 'receipt_items'
  | 'qr'
  | 'printer_label'
  | 'calibration';

/**
 * What to draw, expressed as ids rather than as drawn content.
 *
 * A recipe is resolved against the database at render time, which is what lets
 * a queued job pick up an edit made in the seconds before it prints (D11), and
 * what stops a caller from putting a price on a tag that no item ever had.
 */
export interface PrintRecipe {
  kind: PrintRecipeKind;
  itemId?: string | null;
  sellerId?: string | null;
  swapId?: string | null;
  printerId?: string | null;
  params?: unknown;
}

/**
 * The single place a recipe becomes pixels.
 *
 * Both consumers go through here — the ESP-32 bridge draining a station queue,
 * and a browser driving a Phomemo over Web Bluetooth — so the two paths cannot
 * drift the way the browser and server renderers already did once (§5).
 */
@Injectable()
export class PrintRecipeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: LabelRendererService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Resolves a recipe to one raster per label. Most kinds produce a single
   * page; a receipt's item list paginates across as many as it needs.
   */
  async resolve(orgId: string, recipe: PrintRecipe, target: PrintTarget): Promise<boolean[][][]> {
    switch (recipe.kind) {
      case 'calibration':
        return [this.renderer.calibration(target)];

      case 'item': {
        if (!recipe.itemId) throw new BadRequestException('An item tag needs an item');
        const item = await this.prisma.swapItem.findFirst({
          where: { id: recipe.itemId, orgId, deletedAt: null },
        });
        if (!item) throw new NotFoundException('Item no longer exists');
        // Only a legacy ticket is ever unpriced (Plan 32). A priced one may be
        // printed a replacement tag, same number and barcode as its paper
        // ticket; an unpriced one waits for its price.
        if (item.priceCents === null) {
          throw new BadRequestException(`Ticket ${item.sku} has no price yet. Price it, then print its tag.`);
        }
        const settings = await this.prisma.skiSwapSettings.findUnique({
          where: { orgId },
          select: { barcodesPerTicket: true },
        });
        return [
          await this.renderer.itemTag(
            { name: item.name, priceCents: item.priceCents, sku: item.sku, barcodes: barcodesOf(settings) },
            target,
          ),
        ];
      }

      case 'printer_label': {
        if (!recipe.printerId) throw new BadRequestException('A printer label needs a printer');
        const printer = await this.prisma.swapPrinter.findFirst({
          where: { id: recipe.printerId, orgId },
          include: { org: true },
        });
        if (!printer) throw new NotFoundException('Printer not found');
        return [await this.renderer.printerLabel(printer.name, printer.org.name, target)];
      }

      case 'qr': {
        const seller = await this.seller(orgId, recipe.sellerId);
        return [await this.renderer.qrLabel(seller.name, seller.statusUrl, target)];
      }

      case 'receipt_header': {
        // On the tall tier the receipt is one page with its masthead built in
        // (see `receipt_items`), so a separate header label would print it
        // twice. A client that asks for both, as the web does, gets nothing
        // here and the whole receipt from the items.
        if (target.size.tier === 'tall') return [];
        const seller = await this.seller(orgId, recipe.sellerId);
        // An older client sends no swap; its header is drawn as it always was.
        if (!recipe.swapId) {
          return [await this.renderer.receiptHeader(this.masthead(seller, await this.orgTimeZone(orgId)), target)];
        }
        // Settings that refuse this print give nothing, so a job queued
        // before they changed settles unprinted at claim (Plan 36).
        const gate = await this.receiptGate(orgId, recipe.swapId, recipe.sellerId!, target);
        if (!gate) return [];
        return [await this.renderer.receiptHeader(this.masthead(seller, gate.timeZone, gate.layout), target)];
      }

      case 'receipt_items': {
        if (!recipe.swapId || !recipe.sellerId) {
          throw new BadRequestException('A receipt needs a seller and a swap');
        }
        const gate = await this.receiptGate(orgId, recipe.swapId, recipe.sellerId, target);
        if (!gate) return [];
        const { layout } = gate;
        const statusOnly = layout.mode === 'STATUS_ONLY';
        const items = statusOnly ? [] : await this.prisma.swapItem.findMany({
          where: { orgId, swapId: recipe.swapId, sellerId: recipe.sellerId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { name: true, sku: true, priceCents: true },
        });
        // On the tall tier this job is the whole receipt — the masthead is part
        // of page one rather than a page of its own, so `enqueueReceipt` queues
        // no header job and there is nothing here to concatenate.
        if (target.size.tier === 'tall') {
          const seller = await this.seller(orgId, recipe.sellerId);
          return this.renderer.tallReceipt(
            this.masthead(seller, gate.timeZone, layout), items, target, { show: layout.show, statusOnly },
          );
        }
        // A compact status-only receipt is its header label alone.
        if (statusOnly) return [];
        return this.renderer.receiptItems(items, target, layout.show);
      }

      default:
        throw new BadRequestException(`Unsupported label kind: ${String(recipe.kind)}`);
    }
  }

  /**
   * How many labels a receipt's item list will take, so the enqueue can lay out
   * one job per page without rendering them a second time at claim (D11).
   */
  async receiptPageCount(orgId: string, swapId: string, sellerId: string, target: PrintTarget): Promise<number> {
    const pages = await this.resolve(orgId, { kind: 'receipt_items', swapId, sellerId }, target);
    return pages.length;
  }

  /**
   * This receipt's layout and its swap's time zone, when the swap's settings
   * let it print on this target; null when they don't: no receipts, printing
   * off, or other paper.
   */
  private async receiptGate(
    orgId: string, swapId: string, sellerId: string, target: PrintTarget,
  ): Promise<{ layout: ReceiptLayout; timeZone: string } | null> {
    const swap = await this.prisma.skiSwap.findFirst({
      where: { id: swapId, orgId },
      include: { org: { select: { slug: true } } },
    });
    if (!swap || receiptPrintRefusal(swap, target.size.id)) return null;
    // The token behind a sign-in link: this seller's latest receipt here.
    const receipt = await this.prisma.receipt.findFirst({
      where: { orgId, swapId, sellerId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { token: true },
    });
    const layout = receiptLayout(swap, {
      sellerSiteUrl: this.config.get<string>('app.sellerSiteUrl', 'http://localhost:3000'),
      appUrl: this.config.get<string>('app.appUrl', 'http://localhost:3000'),
      orgSlug: swap.org.slug,
      sellerId,
      receiptToken: receipt?.token ?? null,
    });
    return { layout, timeZone: swap.timeZone };
  }

  /**
   * The zone for a header an older client asked for without naming its swap:
   * the org's newest running swap's, which is the one at the counter.
   */
  private async orgTimeZone(orgId: string): Promise<string> {
    const swap = await this.prisma.skiSwap.findFirst({
      where: { orgId, active: true },
      orderBy: { createdAt: 'desc' },
      select: { timeZone: true },
    });
    return swap?.timeZone ?? DEFAULT_SWAP_TIME_ZONE;
  }

  /** Who the receipt is for, however the tier chooses to lay it out. */
  private masthead(
    seller: {
      orgLogoUrl: string | null;
      name: string;
      phone: string | null;
      statusUrl: string;
    },
    /** The swap's zone, which the date is given in. */
    timeZone: string,
    /** The swap's receipt layout (Plan 36); absent for an older client's header. */
    layout?: ReceiptLayout,
  ): ReceiptHeaderData {
    const link = layout ? layout.link : { url: seller.statusUrl, kind: 'SELLER_STATUS' as const };
    return {
      qrUrl: link?.url ?? null,
      qrCaption: link ? QR_CAPTIONS[link.kind] : undefined,
      // A status-only receipt whose page has been turned off says so (D2).
      note: layout?.mode === 'STATUS_ONLY' && !link ? 'Status page not available' : undefined,
      orgLogoUrl: seller.orgLogoUrl,
      // Rendered at claim rather than at enqueue, so it is when the receipt
      // actually printed.
      date: swapTimeText(new Date(), timeZone),
      sellerName: seller.name,
      phone: seller.phone ?? '',
    };
  }

  /** The seller's display name, phone, and the absolute URL their QR points at. */
  private async seller(orgId: string, sellerId: string | null | undefined) {
    if (!sellerId) throw new BadRequestException('This label needs a seller');
    const seller = await this.prisma.sellerProfile.findFirst({
      // Scoped through the membership: a seller belongs to an org by way of one.
      where: { id: sellerId, membership: { orgId } },
      include: { membership: { include: { user: true, org: true } } },
    });
    if (!seller) throw new NotFoundException('Seller no longer exists');

    const user = seller.membership.user;
    const name = displayName(user, seller.businessName);

    const base = this.config.get<string>('app.sellerSiteUrl')!;
    return {
      name,
      phone: user.phone,
      orgLogoUrl: seller.membership.org.logoUrl,
      // Absolute, and resolved here rather than by the caller: the QR is
      // printed once and scanned days later, so a relative path is useless and
      // a browser-supplied origin would be a guess at best.
      statusUrl: `${base.replace(/\/$/, '')}/s/${seller.id}`,
    };
  }
}

/** A printer's own model, stock and margins, falling back to the defaults. */
export function printTargetFor(
  printer: {
    model: string;
    paperSize: string;
    marginTop: number;
    marginBottom: number;
    marginLeft: number;
    marginRight: number;
  } | null,
): PrintTarget {
  if (!printer) return DEFAULT_TARGET;
  return printTarget(printer.model, printer.paperSize, {
    marginTop: printer.marginTop,
    marginBottom: printer.marginBottom,
    marginLeft: printer.marginLeft,
    marginRight: printer.marginRight,
  });
}
