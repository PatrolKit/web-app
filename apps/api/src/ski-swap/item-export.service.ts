import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { displayName } from '../common/util/person';
import { ItemService } from './item.service';
import { ItemBreakdownService } from './item-breakdown.service';
import { TaxonomyService } from './taxonomy/taxonomy.service';
import { SELLER_NAME_INCLUDE, sellerDisplayName } from './seller.service';
import { attributeSales, type DecisionRef } from './sales-check';
import { exportRows, exportWorkbook } from './item-export';
import type { ItemListView } from './item-list-order';

/** The Items page's filters, as the export takes them. */
export type ExportFilters = { query?: string; sellerId?: string } & ItemListView;

/** Who asked: a staff member, or a patrol device (the pickup iPad, iOS Plan 38). */
export type ExportActor = { type: 'user' | 'device'; id: string };

const STATUS_LABEL: Record<string, string> = {
  for_sale: 'For sale', sold: 'Sold', not_received: 'Not yet received', not_in_square: 'Not in Square', needs_price: 'Needs a price', picked_up: 'Picked up',
};

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * The Items export: every item matching the page's filters, not one page, as
 * a spreadsheet to download or email. Sales are read fresh from Square for
 * it (not the dashboard's two-minute copy), so what sold is as of now.
 */
@Injectable()
export class ItemExportService {
  private readonly logger = new Logger(ItemExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemService,
    private readonly breakdown: ItemBreakdownService,
    private readonly taxonomy: TaxonomyService,
    private readonly mail: MailService,
  ) {}

  /** The file, and what it holds. */
  async build(orgId: string, swapId: string, filters: ExportFilters, actor: ExportActor): Promise<{ filename: string; contentType: string; content: Buffer; items: number; filters: string; swapTitle: string; orgName: string; exportedBy: string }> {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { id: true, title: true, timeZone: true, org: { select: { name: true } } } });
    if (!swap) throw new NotFoundException('Swap not found');

    // Fresh: the cached read is dropped first, so the filter (Sold, For sale)
    // and the rows both use this one read of Square.
    this.breakdown.forgetSales(swapId);
    let raw: Awaited<ReturnType<ItemBreakdownService['rawSales']>>;
    try {
      raw = await this.breakdown.rawSales(orgId, swapId);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      this.logger.warn({ err, swapId }, 'Items export: Square couldn’t be read');
      throw new BadRequestException('Square’s sales couldn’t be read, so the export can’t say what sold. Try again in a minute.');
    }

    const ids = await this.items.matchingIds(orgId, swapId, filters);
    const [rows, every, decisions, exchanges, sender] = await Promise.all([
      this.prisma.swapItem.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: {
          id: true, sku: true, name: true, description: true, categoryId: true, priceCents: true, originalQuantity: true,
          squareVariationId: true, consignedAt: true, hasPrintedTag: true, donateProceeds: true, pickedUpAt: true, pickedUpByName: true,
          seller: { include: SELLER_NAME_INCLUDE },
        },
      }),
      // Every item's variation, withdrawn ones too: a sale on one counts where it belongs.
      this.prisma.swapItem.findMany({ where: { swapId }, select: { id: true, sku: true, squareVariationId: true } }),
      this.prisma.swapSaleDecision.findMany({ where: { swapId, liveKey: { not: null } }, select: { orderId: true, lineUid: true, decision: true, itemId: true } }),
      this.prisma.swapExchange.findMany({ where: { swapId, liveKey: { not: null } }, select: { orderId: true, lineUid: true, returnedItemId: true, replacementItemId: true } }),
      this.senderName(actor),
    ]);
    const variationOfItem = new Map(every.filter((i) => i.squareVariationId).map((i) => [i.id, i.squareVariationId!]));
    const lines = attributeSales(raw.lines, decisions as DecisionRef[], exchanges, new Set(variationOfItem.values()), variationOfItem);
    const skuOf = new Map(every.map((i) => [i.id, i.sku]));
    const named = exchanges.map((e) => ({ ...e, returnedSku: skuOf.get(e.returnedItemId) ?? '?', replacementSku: skuOf.get(e.replacementItemId) ?? '?' }));
    const descriptions = await this.taxonomy.describeItems(rows.map((r) => ({ id: r.id, categoryId: r.categoryId })));

    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => !!r);
    const table = exportRows(ordered.map((r) => ({
      id: r.id, sku: r.sku, name: r.name, description: r.description,
      category: descriptions.get(r.id)?.category?.label ?? null,
      sellerName: sellerDisplayName(r.seller), sellerPhone: r.seller?.membership.user.phone ?? null, sellerEmail: r.seller?.membership.user.email ?? null,
      priceCents: r.priceCents, quantity: r.originalQuantity, squareVariationId: r.squareVariationId,
      consigned: r.consignedAt !== null, hasPrintedTag: r.hasPrintedTag, donateProceeds: r.donateProceeds,
      pickedUpAt: r.pickedUpAt, pickedUpBy: r.pickedUpByName,
    })), lines, named);

    const described = await this.describeFilters(filters);
    const exportedBy = sender ?? 'Someone';
    const at = new Date();
    const content = await exportWorkbook(table, { swap: swap.title, filters: described, exportedBy, at, timeZone: swap.timeZone });
    const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const slug = swap.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'swap';
    return { filename: `${slug}-items-${stamp}.xlsx`, contentType: XLSX, content, items: table.length, filters: described, swapTitle: swap.title, orgName: swap.org.name, exportedBy };
  }

  /** Download: the file, audited. */
  async download(orgId: string, swapId: string, filters: ExportFilters, actor: ExportActor) {
    const file = await this.build(orgId, swapId, filters, actor);
    await this.audit(orgId, actor, { swapId, how: 'download', items: file.items, filters: file.filters });
    return file;
  }

  /** Email: the file attached, to the address typed, audited with it. */
  async email(orgId: string, swapId: string, filters: ExportFilters, to: string, actor: ExportActor): Promise<{ to: string; items: number; status: string }> {
    const file = await this.build(orgId, swapId, filters, actor);
    const outcome = await this.mail.sendItemsExport(to, {
      orgName: file.orgName, swapTitle: file.swapTitle, senderName: file.exportedBy, items: file.items, filters: file.filters,
      file: { filename: file.filename, content: file.content, contentType: file.contentType },
    });
    await this.audit(orgId, actor, { swapId, how: 'email', to, items: file.items, filters: file.filters, status: outcome.status });
    if (outcome.status === 'suppressed') {
      throw new BadRequestException(`The email wasn’t sent: ${'reason' in outcome ? outcome.reason : 'email is off here'}.`);
    }
    return { to, items: file.items, status: outcome.status };
  }

  /** "Sold · search “poles” · seller Little Mountain · sorted by price, high first". */
  private async describeFilters(f: ExportFilters): Promise<string> {
    const parts: string[] = [];
    if (f.status) parts.push(STATUS_LABEL[f.status] ?? f.status);
    if (f.sellerKind) parts.push(f.sellerKind === 'business' ? 'business sellers' : 'individual sellers');
    if (f.printed !== undefined) parts.push(f.printed ? 'tag printed' : 'tag not printed');
    if (f.query?.trim()) parts.push(`search “${f.query.trim()}”`);
    if (f.sellerId) {
      const seller = await this.prisma.sellerProfile.findUnique({ where: { id: f.sellerId }, select: { businessName: true, ...SELLER_NAME_INCLUDE } });
      parts.push(`seller ${sellerDisplayName(seller) ?? 'chosen'}`);
    }
    if (f.sort) parts.push(`sorted by ${f.sort}${f.dir === 'desc' ? ', descending' : ''}`);
    return parts.join(' · ');
  }

  /**
   * One seller's items still out, unsold, emailed (iOS Plan 38): the pickup
   * iPad's Items remaining list, as the Items page's For sale filter has it.
   * Always that filter and that seller; a seller of another org is refused.
   */
  async emailRemaining(orgId: string, swapId: string, sellerId: string, to: string, actor: ExportActor) {
    const seller = await this.prisma.sellerProfile.findFirst({ where: { id: sellerId, deletedAt: null, membership: { orgId } }, select: { id: true } });
    if (!seller) throw new NotFoundException('No such seller in this organization.');
    return this.email(orgId, swapId, { sellerId, status: 'for_sale' }, to, actor);
  }

  /** The email's "from" name: the person's, or the device's ("Pickup iPad"). */
  private async senderName(actor: ExportActor): Promise<string | null> {
    if (actor.type === 'device') {
      return (await this.prisma.device.findUnique({ where: { id: actor.id }, select: { name: true } }))?.name ?? null;
    }
    const user = await this.prisma.user.findUnique({ where: { id: actor.id }, select: { firstName: true, lastName: true, email: true, phone: true } });
    return user ? displayName(user) : null;
  }

  private async audit(orgId: string, actor: ExportActor, metadata: Record<string, unknown>) {
    await this.prisma.auditLog.create({
      data: { actorType: actor.type, actorId: actor.id, orgId, action: 'ski_swap.items.exported', metadata: metadata as Prisma.InputJsonValue },
    });
  }
}
