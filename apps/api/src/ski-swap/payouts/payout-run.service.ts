import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../../prisma/prisma.service';
import { PosAdapterFactory } from '../pos/pos.adapter';
import { sellerDisplayName, SELLER_NAME_INCLUDE } from '../seller.service';
import { buildRun, discountsOf, type BuiltRun, type RunItem, type RunSeller } from './build-run';
import { buildRecipient, mapItemStatus, type PayoutMethod, type PayoutTarget } from './paypal-mapping';
import { PayPalClient, PayPalError, type PayoutItemRequest } from './paypal.client';
import { formatCents } from './money';
import { checksToCsv, phoneForHumans, type CheckRow } from './checks-csv';
import { TERMINAL_PAYOUT_STATUSES, type PayoutLineStatus } from '../../contracts/payouts.contracts';

/**
 * Payout runs: building them, approving them, and sending them (Plan 25 §4–§7).
 *
 * The arithmetic lives in build-run.ts and the HTTP in paypal.client.ts. What
 * is left here is the part that has to be got right about *order*: which state
 * a line may leave, when a person's approval is recorded, and what happens when
 * PayPal answers slowly, badly, or not at all.
 */
@Injectable()
export class PayoutRunService {
  private readonly logger = new Logger(PayoutRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pos: PosAdapterFactory,
    private readonly paypal: PayPalClient,
  ) {}

  // ─── Building ───────────────────────────────────────────────────────────────

  /**
   * Reads the swap's sales and works out what everybody is owed.
   *
   * One open run per swap. A second would compute the same amounts from the
   * same orders, and approving one of the two would pay everybody twice — so
   * the second is refused rather than reconciled.
   */
  async create(
    orgId: string,
    swapId: string,
    actorId: string,
    opts: { salesFrom?: string; salesTo?: string },
  ) {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId } });
    if (!swap) throw new NotFoundException('Swap not found');

    const open = await this.prisma.payoutRun.findFirst({
      where: { swapId, status: { in: ['DRAFT', 'REVIEW'] } },
    });
    if (open) {
      throw new ConflictException(
        `This swap already has an open payout run. Close it before starting another.`,
      );
    }

    const settings = await this.prisma.skiSwapSettings.findUnique({ where: { orgId } });
    const commissionBasisPoints = settings?.commissionBasisPoints ?? 0;
    const minimumCents = settings?.payoutMinimumCents ?? 100;

    // The window. Defaults to the swap's whole life, because the alternative —
    // guessing at its dates — can only ever guess short, and a sale outside the
    // window is a seller who is not paid.
    const salesFrom = opts.salesFrom ? new Date(opts.salesFrom) : swap.createdAt;
    const salesTo = opts.salesTo ? new Date(opts.salesTo) : new Date();
    if (salesTo <= salesFrom) {
      throw new BadRequestException('The sales window ends before it begins');
    }

    const adapter = await this.pos.forOrg(orgId);
    if (!adapter) {
      throw new BadRequestException('Square is not configured, so there are no sales to read');
    }
    if (!swap.locationId) {
      throw new BadRequestException('This swap has no Square location, so sales cannot be read');
    }

    const sales = await adapter.listSales(swap.locationId, salesFrom, salesTo);

    const itemRows = await this.prisma.swapItem.findMany({
      where: { swapId },
      select: {
        id: true, name: true, sku: true, priceCents: true,
        squareVariationId: true, donateProceeds: true, sellerId: true,
      },
    });
    const items: RunItem[] = itemRows;

    const sellerIds = [...new Set(itemRows.map((i) => i.sellerId).filter((id): id is string => !!id))];
    const sellerRows = await this.prisma.sellerProfile.findMany({
      where: { id: { in: sellerIds } },
      select: {
        id: true,
        businessName: true,
        ...SELLER_NAME_INCLUDE,
        membership: {
          select: {
            user: {
              select: {
                firstName: true, lastName: true, email: true, phone: true,
                payoutMethod: true, payoutTarget: true, payoutHandle: true,
                verifiedEmail: true, verifiedPhone: true,
              },
            },
          },
        },
      },
    });

    const sellers: RunSeller[] = sellerRows.map((s) => ({
      sellerId: s.id,
      name: sellerDisplayName(s) ?? 'Unnamed seller',
      // A seller who never answered is treated as a check. It is the one
      // method that cannot go anywhere wrong on its own — it waits for a
      // person — where defaulting to an electronic method would guess at
      // somebody's money.
      method: (s.membership.user.payoutMethod as PayoutMethod | null) ?? 'CHECK',
      target: (s.membership.user.payoutTarget as PayoutTarget | null) ?? null,
      handle: s.membership.user.payoutHandle,
      verifiedEmail: s.membership.user.verifiedEmail,
      verifiedPhone: s.membership.user.verifiedPhone,
    }));

    const built = buildRun(items, sellers, sales, { commissionBasisPoints, minimumCents });
    const runId = createId();

    await this.prisma.$transaction(async (tx) => {
      await tx.payoutRun.create({
        data: {
          id: runId,
          orgId,
          swapId,
          status: 'REVIEW',
          salesFrom,
          salesTo,
          commissionBasisPoints,
          // Stored, not just logged. A sale that matched nothing is money the
          // org took that nobody is being paid for, and the only response
          // guaranteed to mean nobody looks is silence.
          unmatchedSales: built.unmatched.length ? (built.unmatched as never) : undefined,
        },
      });

      for (const line of built.lines) {
        const lineId = createId();
        await tx.payoutLine.create({
          data: {
            id: lineId,
            runId,
            sellerId: line.sellerId,
            sellerName: line.sellerName,
            method: line.method,
            destination: line.destination,
            destinationType: line.destinationType,
            grossCents: line.grossCents,
            commissionCents: line.commissionCents,
            netCents: line.netCents,
            status: line.status,
            statusNote: line.statusNote,
          },
        });
        await tx.payoutLineItem.createMany({
          data: line.items.map((i) => ({
            id: createId(),
            lineId,
            itemId: i.itemId,
            name: i.name,
            sku: i.sku,
            priceCents: i.priceCents,
            quantity: i.quantity,
            collectedCents: i.collectedCents,
            squareOrderId: i.squareOrderId,
            soldAt: i.soldAt,
            refundedQty: i.refundedQty,
          })),
        });
      }
    });

    await this.audit(orgId, actorId, 'payout_run.created', runId, {
      lines: built.lines.length,
      unmatched: built.unmatched.length,
      commissionBasisPoints,
    });

    if (built.unmatched.length) {
      this.logger.warn(
        { runId, count: built.unmatched.length },
        'Sales in this window matched no item of the swap',
      );
    }

    return this.get(orgId, runId);
  }

  // ─── Reading ────────────────────────────────────────────────────────────────

  async list(orgId: string, swapId?: string) {
    const runs = await this.prisma.payoutRun.findMany({
      where: { orgId, ...(swapId ? { swapId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { swap: { select: { title: true } }, lines: { select: { status: true, netCents: true } } },
    });

    return runs.map((run) => ({
      id: run.id,
      swapId: run.swapId,
      swapTitle: run.swap.title,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
      closedAt: run.closedAt?.toISOString() ?? null,
      lineCount: run.lines.length,
      unmatchedCount: ((run.unmatchedSales ?? []) as unknown[]).length,
      totalNetCents: run.lines.reduce((sum, l) => sum + l.netCents, 0),
      byStatus: tally(run.lines.map((l) => l.status)),
    }));
  }

  async get(orgId: string, runId: string) {
    const run = await this.prisma.payoutRun.findFirst({
      where: { id: runId, orgId },
      include: {
        swap: { select: { title: true } },
        lines: { include: { items: true }, orderBy: { netCents: 'desc' } },
      },
    });
    if (!run) throw new NotFoundException('Payout run not found');

    return {
      id: run.id,
      swapId: run.swapId,
      swapTitle: run.swap.title,
      status: run.status,
      salesFrom: run.salesFrom.toISOString(),
      salesTo: run.salesTo.toISOString(),
      commissionBasisPoints: run.commissionBasisPoints,
      sendAttempt: run.sendAttempt,
      unmatchedSales: (run.unmatchedSales ?? []) as BuiltRun['unmatched'],
      createdAt: run.createdAt.toISOString(),
      closedAt: run.closedAt?.toISOString() ?? null,
      totals: {
        grossCents: run.lines.reduce((s, l) => s + l.grossCents, 0),
        commissionCents: run.lines.reduce((s, l) => s + l.commissionCents, 0),
        netCents: run.lines.reduce((s, l) => s + l.netCents, 0),
      },
      byStatus: tally(run.lines.map((l) => l.status)),
      lines: run.lines.map((l) => ({
        id: l.id,
        sellerId: l.sellerId,
        sellerName: l.sellerName,
        method: l.method,
        destination: l.destination,
        destinationType: l.destinationType,
        grossCents: l.grossCents,
        commissionCents: l.commissionCents,
        netCents: l.netCents,
        status: l.status,
        statusNote: l.statusNote,
        approvedBy: l.approvedBy,
        approvedAt: l.approvedAt?.toISOString() ?? null,
        sentAt: l.sentAt?.toISOString() ?? null,
        payoutBatchId: l.payoutBatchId,
        payoutItemId: l.payoutItemId,
        checkNumber: l.checkNumber,
        checkSentAt: l.checkSentAt?.toISOString() ?? null,
        items: l.items.map((i) => ({
          id: i.id,
          itemId: i.itemId,
          name: i.name,
          sku: i.sku,
          priceCents: i.priceCents,
          quantity: i.quantity,
          collectedCents: i.collectedCents,
          squareOrderId: i.squareOrderId,
          soldAt: i.soldAt.toISOString(),
          refundedQty: i.refundedQty,
        })),
      })),
    };
  }

  /** The discount report (§5): every sale the register took less for than listed. */
  async discounts(orgId: string, runId: string) {
    const run = await this.prisma.payoutRun.findFirst({
      where: { id: runId, orgId },
      include: { lines: { include: { items: true } } },
    });
    if (!run) throw new NotFoundException('Payout run not found');

    const { discounts, totalGapCents } = discountsOf(run.lines);
    return { runId, discounts, totalGapCents, totalGapFormatted: formatCents(totalGapCents) };
  }

  // ─── Approving ──────────────────────────────────────────────────────────────

  /**
   * Records that a person looked at these lines and said yes (§7).
   *
   * Only PENDING may become APPROVED, and only APPROVED may go back. Everything
   * further along has either been handed to PayPal or has already moved money,
   * and an approval toggle is not a thing that should be able to reach it.
   */
  async approve(
    orgId: string,
    runId: string,
    lineIds: string[],
    approved: boolean,
    actorId: string,
  ) {
    const run = await this.prisma.payoutRun.findFirst({ where: { id: runId, orgId } });
    if (!run) throw new NotFoundException('Payout run not found');
    if (run.status !== 'REVIEW') {
      throw new ConflictException(`A ${run.status.toLowerCase()} run cannot be approved`);
    }

    const from = approved ? 'PENDING' : 'APPROVED';
    const to = approved ? 'APPROVED' : 'PENDING';

    const result = await this.prisma.payoutLine.updateMany({
      where: { runId, id: { in: lineIds }, status: from },
      data: {
        status: to,
        approvedBy: approved ? actorId : null,
        approvedAt: approved ? new Date() : null,
      },
    });

    await this.audit(orgId, actorId, approved ? 'payout_line.approved' : 'payout_line.unapproved', runId, {
      requested: lineIds.length,
      changed: result.count,
    });

    // Reported rather than thrown: a treasurer approving a page of lines where
    // one was already approved wants the other forty-nine to have gone through.
    return { requested: lineIds.length, changed: result.count };
  }

  // ─── Sending ────────────────────────────────────────────────────────────────

  /**
   * Hands the approved electronic lines to PayPal.
   *
   * The one-way door. Lines move to SENDING *before* the call and never move
   * back on their own, because the failure that matters is not "the batch was
   * rejected" — it is "we do not know whether it was". A line sitting in
   * SENDING is a question for a person; a line that quietly returned to
   * APPROVED is a second payment waiting to happen.
   */
  async send(orgId: string, runId: string, expectedLineCount: number, actorId: string) {
    const run = await this.prisma.payoutRun.findFirst({ where: { id: runId, orgId } });
    if (!run) throw new NotFoundException('Payout run not found');
    if (run.status !== 'REVIEW') {
      throw new ConflictException(`A ${run.status.toLowerCase()} run cannot be sent`);
    }

    // A resume rather than a new send. Lines left in SENDING mean a previous
    // attempt did not come back, so this re-posts the *same* sender_batch_id:
    // PayPal dedupes it for thirty days and returns the batch it already has.
    // Bumping the attempt here is precisely how a double payment happens.
    const inFlight = await this.prisma.payoutLine.count({ where: { runId, status: 'SENDING' } });
    const attempt = inFlight > 0 ? run.sendAttempt : run.sendAttempt + 1;

    if (inFlight === 0) {
      const approved = await this.prisma.payoutLine.count({
        where: { runId, status: 'APPROVED', method: { in: ['PAYPAL', 'VENMO'] } },
      });
      // The screen said one number and the server holds another: somebody
      // approved or unapproved a line between looking and clicking. Refused,
      // because the whole point of the confirmation is that the operator knows
      // what they are authorising.
      if (approved !== expectedLineCount) {
        throw new ConflictException(
          `This run now has ${approved} approved payouts, not ${expectedLineCount}. Review it again.`,
        );
      }
      if (approved === 0) throw new BadRequestException('No approved payouts to send');

      await this.prisma.$transaction([
        this.prisma.payoutRun.update({ where: { id: runId }, data: { sendAttempt: attempt } }),
        this.prisma.payoutLine.updateMany({
          where: { runId, status: 'APPROVED', method: { in: ['PAYPAL', 'VENMO'] } },
          // No `sentAt` here. It means "PayPal confirmed this arrived", and
          // writing it at handover would make a line that is still in flight
          // — or one that failed — read as paid on every screen in the app.
          data: { status: 'SENDING' },
        }),
      ]);
    }

    const lines = await this.prisma.payoutLine.findMany({ where: { runId, status: 'SENDING' } });
    const senderBatchId = `${runId}-${attempt}`;

    const items: PayoutItemRequest[] = [];
    for (const line of lines) {
      if (!line.destination) {
        // Cannot happen for a line that reached APPROVED, but a payout batch is
        // the wrong place to discover it if it does.
        await this.failLine(line.id, 'No destination — this line was approved without one');
        continue;
      }
      items.push({
        senderItemId: line.id,
        amountCents: line.netCents,
        recipient: buildRecipient(
          line.method as PayoutMethod,
          line.destinationType as PayoutTarget | null,
          line.destination,
        ),
        note: `Ski swap payout — ${formatCents(line.netCents)}`,
      });
    }

    if (!items.length) throw new BadRequestException('No sendable payouts in this run');

    await this.audit(orgId, actorId, 'payout_run.sent', runId, {
      senderBatchId,
      count: items.length,
      totalCents: items.reduce((s, i) => s + i.amountCents, 0),
    });

    let result;
    try {
      result = await this.paypal.createBatch(orgId, senderBatchId, items);
    } catch (err) {
      if (err instanceof PayPalError && !err.retryable) {
        // A 4xx was refused outright: nothing was queued, so it is safe — and
        // necessary — to put these back where a person can fix them.
        await this.prisma.payoutLine.updateMany({
          where: { runId, status: 'SENDING' },
          data: { status: 'APPROVED', statusNote: `PayPal refused the batch: ${err.message}` },
        });
        throw new BadRequestException(`PayPal refused the batch: ${err.message}`);
      }
      // Anything else — a 5xx, a timeout, a dropped socket — leaves the lines
      // in SENDING on purpose. Sending again re-posts the same batch id, which
      // PayPal will not honour twice.
      this.logger.error({ runId, senderBatchId, err }, 'Payout batch did not come back');
      throw new ConflictException(
        'PayPal did not answer. The payouts are marked as sending; use Send again to retry safely.',
      );
    }

    await this.applyBatchResult(result.batchId, result.items);
    return this.get(orgId, runId);
  }

  /**
   * Writes PayPal's view of a batch onto our lines.
   *
   * Shared by the send, the webhook and the sweep, so all three can only ever
   * disagree by being run at different times — never by reading the same answer
   * two ways.
   */
  async applyBatchResult(
    batchId: string,
    items: { senderItemId: string; payoutItemId: string; transactionStatus: string; errorMessage?: string }[],
  ) {
    for (const item of items) {
      if (!item.senderItemId) continue;
      let mapped;
      try {
        mapped = mapItemStatus(item.transactionStatus);
      } catch (err) {
        // An unrecognised status stops this one line and leaves it visibly
        // stuck, rather than being rounded to the nearest thing we know.
        this.logger.error({ item, err }, 'Unrecognised PayPal item status');
        await this.prisma.payoutLine.updateMany({
          where: { id: item.senderItemId },
          data: { statusNote: `PayPal reported an unknown status: ${item.transactionStatus}` },
        });
        continue;
      }

      await this.prisma.payoutLine.updateMany({
        // Never overwrite a line that has already arrived somewhere final. A
        // late webhook must not walk SENT backwards.
        where: { id: item.senderItemId, status: { notIn: [...TERMINAL_PAYOUT_STATUSES] } },
        data: {
          status: mapped.status,
          statusNote: item.errorMessage ?? mapped.note ?? null,
          payoutBatchId: batchId,
          payoutItemId: item.payoutItemId || undefined,
          ...(mapped.status === 'SENT' ? { sentAt: new Date() } : {}),
        },
      });
    }
  }

  /**
   * Everyone owed a check on this run, with where to post it (§10).
   *
   * The address is read live rather than frozen with the line. A run built in
   * November and printed in December should go to where the seller lives in
   * December — unlike the *amount*, which is settled at build time and must
   * never move under them.
   */
  async checks(orgId: string, runId: string): Promise<CheckRow[]> {
    const run = await this.prisma.payoutRun.findFirst({
      where: { id: runId, orgId },
      include: {
        lines: {
          where: { method: 'CHECK' },
          orderBy: { sellerName: 'asc' },
          include: {
            seller: {
              select: {
                membership: {
                  select: {
                    user: {
                      select: { street: true, city: true, state: true, zip: true, verifiedPhone: true, phone: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!run) throw new NotFoundException('Payout run not found');

    return run.lines.map((line) => {
      const user = line.seller.membership.user;
      return {
        sellerName: line.sellerName,
        street: user.street,
        city: user.city,
        state: user.state,
        zip: user.zip,
        // The verified number where there is one, but an unverified number is
        // better than a blank column on a check that comes back.
        phone: phoneForHumans(user.verifiedPhone ?? user.phone),
        amountCents: line.netCents,
        reference: line.id,
        checkNumber: line.checkNumber,
        sentAt: line.checkSentAt,
      };
    });
  }

  async checksCsv(orgId: string, runId: string): Promise<string> {
    return checksToCsv(await this.checks(orgId, runId));
  }

  /**
   * Re-reads one batch from PayPal and writes what it says (§8).
   *
   * The backstop behind the webhook. Webhooks are dropped, delayed and
   * occasionally never sent, and a line stuck in SENDING is indistinguishable
   * from money that vanished — so the answer is always available by asking.
   */
  async reconcileBatch(orgId: string, batchId: string) {
    const result = await this.paypal.getBatch(orgId, batchId);
    await this.applyBatchResult(result.batchId || batchId, result.items);
    return { batchId, items: result.items.length };
  }

  /**
   * Re-reads every batch this org has a line still moving in.
   *
   * Cheap and idempotent: `applyBatchResult` refuses to walk a terminal status
   * backwards, so running it twice in a row changes nothing the second time.
   */
  async reconcileOrg(orgId: string) {
    const rows = await this.prisma.payoutLine.findMany({
      where: {
        run: { orgId },
        status: { in: ['SENDING', 'UNCLAIMED'] },
        payoutBatchId: { not: null },
      },
      select: { payoutBatchId: true },
      distinct: ['payoutBatchId'],
    });

    let reconciled = 0;
    for (const row of rows) {
      if (!row.payoutBatchId) continue;
      try {
        await this.reconcileBatch(orgId, row.payoutBatchId);
        reconciled++;
      } catch (err) {
        // One unreadable batch must not stop the rest. The line stays where it
        // is and comes round again on the next sweep.
        this.logger.error({ orgId, batchId: row.payoutBatchId, err }, 'Could not reconcile batch');
      }
    }
    return { batches: rows.length, reconciled };
  }

  // ─── Checks (§10) ───────────────────────────────────────────────────────────

  /** Marks a check line as written and posted, or clears a mark made in error. */
  async recordCheck(
    orgId: string,
    runId: string,
    lineId: string,
    data: { checkNumber?: string | null; sentAt?: string | null },
    actorId: string,
  ) {
    const line = await this.prisma.payoutLine.findFirst({
      where: { id: lineId, run: { id: runId, orgId } },
    });
    if (!line) throw new NotFoundException('Payout line not found');
    if (line.method !== 'CHECK') {
      throw new BadRequestException('This seller is not being paid by check');
    }

    const sentAt = data.sentAt === undefined ? undefined : data.sentAt ? new Date(data.sentAt) : null;
    const updated = await this.prisma.payoutLine.update({
      where: { id: lineId },
      data: {
        ...(data.checkNumber !== undefined ? { checkNumber: data.checkNumber } : {}),
        ...(sentAt !== undefined ? { checkSentAt: sentAt } : {}),
        // The status follows the date, not the number: a check can be written
        // days before it goes in the post, and "paid" should mean posted.
        ...(sentAt !== undefined
          ? { status: sentAt ? 'PAID_BY_CHECK' : 'PENDING' }
          : {}),
      },
    });

    await this.audit(orgId, actorId, 'payout_line.check_recorded', runId, {
      lineId,
      checkNumber: updated.checkNumber,
      sent: !!updated.checkSentAt,
    });
    return { id: updated.id, checkNumber: updated.checkNumber, checkSentAt: updated.checkSentAt?.toISOString() ?? null, status: updated.status };
  }

  // ─── Closing ────────────────────────────────────────────────────────────────

  /**
   * Closes a run. Nothing further can be approved or sent against it.
   *
   * Lines that never resolved keep whatever status they had: closing is an
   * administrative act about the run, and inventing an outcome for a payout
   * nobody chased would be the one thing worse than leaving it visible.
   */
  async close(orgId: string, runId: string, actorId: string) {
    const run = await this.prisma.payoutRun.findFirst({ where: { id: runId, orgId } });
    if (!run) throw new NotFoundException('Payout run not found');
    if (run.status === 'CLOSED') return this.get(orgId, runId);

    const inFlight = await this.prisma.payoutLine.count({ where: { runId, status: 'SENDING' } });
    if (inFlight > 0) {
      throw new ConflictException(
        `${inFlight} payout${inFlight === 1 ? ' is' : 's are'} still in flight with PayPal. Wait for them to settle.`,
      );
    }

    await this.prisma.payoutRun.update({
      where: { id: runId },
      data: { status: 'CLOSED', closedAt: new Date(), closedBy: actorId },
    });
    await this.audit(orgId, actorId, 'payout_run.closed', runId, {});
    return this.get(orgId, runId);
  }

  // ─── Plumbing ───────────────────────────────────────────────────────────────

  private async failLine(lineId: string, note: string) {
    await this.prisma.payoutLine.update({
      where: { id: lineId },
      data: { status: 'FAILED' satisfies PayoutLineStatus, statusNote: note },
    });
  }

  private async audit(
    orgId: string,
    actorId: string,
    action: string,
    runId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        actorType: 'user',
        actorId,
        orgId,
        action,
        targetType: 'payout_run',
        targetId: runId,
        metadata: metadata as never,
      },
    });
  }
}

/** How many lines are in each status, for a header that does not need the rows. */
function tally(statuses: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of statuses) out[s] = (out[s] ?? 0) + 1;
  return out;
}
