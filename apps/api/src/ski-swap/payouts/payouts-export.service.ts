import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { displayName } from '../../common/util/person';
import { PayoutRunService } from './payout-run.service';
import { payoutsWorkbook, runLabel } from './payouts-export';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The swap's payouts, or one run's. */
export type PayoutsExportScope = { swapId: string } | { runId: string };

/**
 * The Payouts export: payouts by seller, for the whole swap (the Payouts page)
 * or one run (its page), as a spreadsheet to download or email.
 */
@Injectable()
export class PayoutsExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: PayoutRunService,
    private readonly mail: MailService,
  ) {}

  async build(orgId: string, scope: PayoutsExportScope, userId: string) {
    const [view, user, org] = await Promise.all([
      this.runs.exportView(orgId, scope),
      this.prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, email: true, phone: true } }),
      this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
    ]);
    const described = view.run ? runLabel(view.run, view.timeZone) : 'Every seller with sales, in any run or none';
    const exportedBy = user ? displayName(user) : 'Someone';
    const at = new Date();
    const content = await payoutsWorkbook(view.rows, { swap: view.swapTitle, scope: described, exportedBy, at, timeZone: view.timeZone });
    const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const slug = view.swapTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'swap';
    const what = view.run ? `${view.run.kind === 'PAYPAL' ? 'paypal' : 'check'}-run` : 'payouts';
    return {
      filename: `${slug}-${what}-${stamp}.xlsx`, contentType: XLSX, content, sellers: view.rows.length,
      scope: described, swapTitle: view.swapTitle, orgName: org?.name ?? 'PatrolKit', exportedBy,
    };
  }

  /** Download: the file, audited. */
  async download(orgId: string, scope: PayoutsExportScope, userId: string) {
    const file = await this.build(orgId, scope, userId);
    await this.audit(orgId, userId, { ...scope, how: 'download', sellers: file.sellers });
    return file;
  }

  /** Email: the file attached, to the address typed, audited with it. */
  async email(orgId: string, scope: PayoutsExportScope, to: string, userId: string): Promise<{ to: string; sellers: number; status: string }> {
    const file = await this.build(orgId, scope, userId);
    const outcome = await this.mail.sendPayoutsExport(to, {
      orgName: file.orgName, swapTitle: file.swapTitle, scope: file.scope, senderName: file.exportedBy, sellers: file.sellers,
      file: { filename: file.filename, content: file.content, contentType: file.contentType },
    });
    await this.audit(orgId, userId, { ...scope, how: 'email', to, sellers: file.sellers, status: outcome.status });
    if (outcome.status === 'suppressed') {
      throw new BadRequestException(`The email wasn’t sent: ${'reason' in outcome ? outcome.reason : 'email is off here'}.`);
    }
    return { to, sellers: file.sellers, status: outcome.status };
  }

  private async audit(orgId: string, userId: string, metadata: Record<string, unknown>) {
    await this.prisma.auditLog.create({
      data: { actorType: 'user', actorId: userId, orgId, action: 'ski_swap.payouts.exported', metadata: metadata as Prisma.InputJsonValue },
    });
  }
}
