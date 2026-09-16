import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { LabelRendererService } from './label-renderer.service';
import { DEFAULT_TARGET, printTarget, type PrintTarget } from './geometry';
import { displayName } from '../../common/util/person';

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
          where: { id: recipe.itemId, orgId },
        });
        if (!item) throw new NotFoundException('Item no longer exists');
        return [
          await this.renderer.itemTag(
            { name: item.name, priceCents: item.priceCents, sku: item.sku },
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
        const seller = await this.seller(orgId, recipe.sellerId);
        return [
          await this.renderer.receiptHeader(
            {
              orgLogoUrl: seller.orgLogoUrl,
              date: new Date().toLocaleString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
                hour: 'numeric', minute: '2-digit',
              }),
              sellerName: seller.name,
              phone: seller.phone ?? '',
              qrUrl: seller.statusUrl,
            },
            target,
          ),
        ];
      }

      case 'receipt_items': {
        if (!recipe.swapId || !recipe.sellerId) {
          throw new BadRequestException('A receipt needs a seller and a swap');
        }
        const items = await this.prisma.swapItem.findMany({
          where: { orgId, swapId: recipe.swapId, sellerId: recipe.sellerId },
          orderBy: { createdAt: 'asc' },
          select: { name: true, sku: true, priceCents: true },
        });
        return this.renderer.receiptItems(items, target);
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
