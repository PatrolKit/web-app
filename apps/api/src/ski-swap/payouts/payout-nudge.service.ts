import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { SmsService } from '../../sms/sms.service';
import type { SendOutcome } from '../../common/messaging/send-outcome';
import { PayPalClient } from './paypal.client';
import { formatCents } from './money';

/**
 * Telling sellers their money is waiting (Plan 25 §9).
 *
 * A PayPal payout to an address with no account behind it sits UNCLAIMED and
 * goes back to the sender after thirty days. Nobody finds out unless we say so,
 * and the cost of that silence is the seller's money.
 *
 * Staff are not nudged. An unapproved run costs nobody anything, and a
 * notification nobody needs is how notifications stop being read.
 */

/** Day 7 and day 21. Two nudges, then PayPal returns it at thirty. */
export const NUDGE_DAY_MARKS = [7, 21] as const;

@Injectable()
export class PayoutNudgeService {
  private readonly logger = new Logger(PayoutNudgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
    private readonly paypal: PayPalClient,
    private readonly config: ConfigService,
  ) {}

  /**
   * Sends whichever nudges are due across an org.
   *
   * Idempotent by the unique index on `(lineId, dayMark)`: running it twice in
   * a day sends nothing the second time, which is what lets it be driven by a
   * plain cron with no locking.
   */
  async sweep(orgId: string) {
    const now = Date.now();
    const results = { considered: 0, sent: 0, suppressed: 0, failed: 0, skipped: 0 };

    const lines = await this.prisma.payoutLine.findMany({
      where: { run: { orgId }, status: 'UNCLAIMED' },
      include: {
        notices: { select: { dayMark: true } },
        run: { select: { orgId: true, swap: { select: { title: true } } } },
        seller: {
          select: {
            membership: {
              select: {
                org: { select: { name: true, logoUrl: true } },
                user: { select: { verifiedEmail: true, verifiedPhone: true, firstName: true } },
              },
            },
          },
        },
      },
    });

    let smsOn: boolean | undefined;
    for (const line of lines) {
      results.considered++;

      // Days since it went unclaimed. `updatedAt` rather than `sentAt`, because
      // a line reaches UNCLAIMED when PayPal says so, which is not when it was
      // handed over.
      const days = Math.floor((now - line.updatedAt.getTime()) / 86_400_000);
      const due = NUDGE_DAY_MARKS.filter(
        (mark) => days >= mark && !line.notices.some((n) => n.dayMark === mark),
      );
      if (!due.length) {
        results.skipped++;
        continue;
      }

      // Only the latest mark that has come due. A line first looked at on day
      // 25 owes one message, not two in the same minute.
      const dayMark = Math.max(...due);
      const user = line.seller.membership.user;
      // Texting off (Plan 29): email only. A seller reachable only by text is
      // recorded unreached, like one with no contact at all.
      smsOn ??= await this.sms.enabled();
      const channel = user.verifiedEmail ? 'EMAIL' : user.verifiedPhone && smsOn ? 'SMS' : null;
      const destination = channel === 'EMAIL' ? user.verifiedEmail : user.verifiedPhone;

      if (!channel || !destination) {
        // Recorded as a failure rather than skipped silently, so "we could not
        // reach this person" is a thing somebody can see and act on.
        await this.record(line.id, dayMark, 'EMAIL', '', {
          status: 'failed',
          error: user.verifiedPhone ? 'Texting is off, and there is no verified email to nudge' : 'No verified contact to nudge',
        });
        results.failed++;
        continue;
      }

      const org = line.seller.membership.org;
      const claimUrl = this.claimUrl();
      let outcome: SendOutcome;
      try {
        outcome =
          channel === 'EMAIL'
            ? await this.mail.sendPayoutNudge(destination, {
                orgName: org.name,
                orgLogoUrl: emailableLogo(org.logoUrl),
                swapTitle: line.run.swap.title,
                amount: formatCents(line.netCents),
                firstName: user.firstName,
                dayMark,
                claimUrl,
              })
            : await this.sms.send(
                destination,
                `${org.name}: your ${formatCents(line.netCents)} ski swap payout is waiting to be claimed. ` +
                  `Check the email or phone number on your PayPal account, or reply to us to change it. ${claimUrl}`,
              );
      } catch (err) {
        outcome = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }

      await this.record(line.id, dayMark, channel, destination, outcome);
      results[outcome.status]++;
    }

    return results;
  }

  /**
   * Takes an unclaimed payout back straight away (§9).
   *
   * A seller who says "that is my old email" should not wait thirty days for
   * their own money. Cancelling returns it now; the line goes back to PENDING
   * so a corrected destination can go in the next batch.
   */
  async cancelUnclaimed(orgId: string, lineId: string, actorId: string) {
    const line = await this.prisma.payoutLine.findFirst({
      where: { id: lineId, run: { orgId } },
    });
    if (!line) throw new NotFoundException('Payout line not found');
    if (line.status !== 'UNCLAIMED' || !line.payoutItemId) {
      throw new NotFoundException('Only an unclaimed payout can be cancelled');
    }

    await this.paypal.cancelItem(orgId, line.payoutItemId);

    // Back to PENDING, not APPROVED. The destination is why this failed, and
    // the approval it already carried was an approval of that destination.
    await this.prisma.payoutLine.update({
      where: { id: lineId },
      data: {
        status: 'PENDING',
        statusNote: 'Returned by cancelling the unclaimed payout — fix the destination and send again',
        approvedBy: null,
        approvedAt: null,
        payoutItemId: null,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorType: 'user',
        actorId,
        orgId,
        action: 'payout_line.cancelled',
        targetType: 'payout_line',
        targetId: lineId,
        metadata: { netCents: line.netCents, payoutItemId: line.payoutItemId },
      },
    });

    return { id: lineId, status: 'PENDING' };
  }

  private claimUrl(): string {
    const base = this.config.get<string>('app.appUrl', 'http://localhost:3000');
    return `${base.replace(/\/$/, '')}/app/seller/items`;
  }

  private async record(
    lineId: string,
    dayMark: number,
    channel: 'EMAIL' | 'SMS',
    destination: string,
    outcome: SendOutcome,
  ) {
    try {
      await this.prisma.payoutNotice.create({
        data: {
          id: createId(),
          lineId,
          dayMark,
          channel,
          destination,
          status: outcome.status.toUpperCase(),
          error:
            outcome.status === 'failed' ? outcome.error
            : outcome.status === 'suppressed' ? (outcome.reason ?? null)
            : null,
        },
      });
    } catch (err) {
      // The unique index doing its job: two sweeps overlapped. The message went
      // once, which is the point of the index, so this is not an error.
      this.logger.warn({ lineId, dayMark, err }, 'A nudge was already recorded for this day mark');
    }
  }
}

/** A mail client cannot fetch a `data:` URI, so the name has to carry it alone. */
function emailableLogo(logoUrl: string | null): string | null {
  return logoUrl && /^https?:\/\//i.test(logoUrl) ? logoUrl : null;
}
