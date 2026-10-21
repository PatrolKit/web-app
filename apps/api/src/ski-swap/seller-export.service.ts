import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { displayName } from '../common/util/person';
import { SellerService } from './seller.service';
import { sellerMatches, sortSellers, type SellerFilters } from '../contracts/seller-filter';
import { sellerExportRows, sellerWorkbook } from './seller-export';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const PAYOUT_LABEL: Record<string, string> = { CHECK: 'Check', PAYPAL: 'PayPal', VENMO: 'Venmo', DONATE: 'Donating', NONE: 'payout not set' };
const SORT_LABEL: Record<string, string> = { displayName: 'name', email: 'email', phone: 'phone', payoutMethod: 'payout' };

/**
 * The Sellers export: every seller matching the Sellers page's filters, as a
 * spreadsheet to download or email. The page lists every seller at once and
 * filters them itself; this finds the same ones by the same rule
 * (`sellerMatches`), so the file is what the page shows, in its order.
 */
@Injectable()
export class SellerExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sellers: SellerService,
    private readonly mail: MailService,
  ) {}

  async build(orgId: string, filters: SellerFilters, userId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    if (!org) throw new NotFoundException('Organization not found');
    const [{ sellers }, user, swap] = await Promise.all([
      this.sellers.list(orgId, undefined, undefined, filters.incomplete === true),
      this.prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, email: true, phone: true } }),
      // The org has no time zone of its own: its newest swap's says when "now" is.
      this.prisma.skiSwap.findFirst({ where: { orgId }, orderBy: { createdAt: 'desc' }, select: { timeZone: true } }),
    ]);
    const matching = sortSellers(sellers.filter((s) => sellerMatches(s, filters)), filters.sort, filters.dir);
    const rows = sellerExportRows(matching);
    const described = describe(filters);
    const exportedBy = user ? displayName(user) : 'Someone';
    const at = new Date();
    const content = await sellerWorkbook(rows, { org: org.name, filters: described, exportedBy, at, timeZone: swap?.timeZone ?? 'America/New_York' });
    const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const slug = org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';
    return { filename: `${slug}-sellers-${stamp}.xlsx`, contentType: XLSX, content, sellers: rows.length, filters: described, orgName: org.name, exportedBy };
  }

  /** Download: the file, audited. */
  async download(orgId: string, filters: SellerFilters, userId: string) {
    const file = await this.build(orgId, filters, userId);
    await this.audit(orgId, userId, { how: 'download', sellers: file.sellers, filters: file.filters });
    return file;
  }

  /** Email: the file attached, to the address typed, audited with it. */
  async email(orgId: string, filters: SellerFilters, to: string, userId: string): Promise<{ to: string; sellers: number; status: string }> {
    const file = await this.build(orgId, filters, userId);
    const outcome = await this.mail.sendSellersExport(to, {
      orgName: file.orgName, senderName: file.exportedBy, sellers: file.sellers, filters: file.filters,
      file: { filename: file.filename, content: file.content, contentType: file.contentType },
    });
    await this.audit(orgId, userId, { how: 'email', to, sellers: file.sellers, filters: file.filters, status: outcome.status });
    if (outcome.status === 'suppressed') {
      throw new BadRequestException(`The email wasn’t sent: ${'reason' in outcome ? outcome.reason : 'email is off here'}.`);
    }
    return { to, sellers: file.sellers, status: outcome.status };
  }

  private async audit(orgId: string, userId: string, metadata: Record<string, unknown>) {
    await this.prisma.auditLog.create({
      data: { actorType: 'user', actorId: userId, orgId, action: 'ski_swap.sellers.exported', metadata: metadata as Prisma.InputJsonValue },
    });
  }
}

/** "business sellers · PayPal · can’t be paid · search “smith” · sorted by email, descending". */
export function describe(f: SellerFilters): string {
  const parts: string[] = [];
  if (f.type) parts.push(f.type === 'business' ? 'business sellers' : 'individual sellers');
  if (f.payout) parts.push(PAYOUT_LABEL[f.payout] ?? f.payout);
  if (f.incomplete) parts.push('can’t be paid');
  if (f.search?.trim()) parts.push(`search “${f.search.trim()}”`);
  if (f.sort && (f.sort !== 'displayName' || f.dir === 'desc')) parts.push(`sorted by ${SORT_LABEL[f.sort] ?? f.sort}${f.dir === 'desc' ? ', descending' : ''}`);
  return parts.join(' · ');
}
