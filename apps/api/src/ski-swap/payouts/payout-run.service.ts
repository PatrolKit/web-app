import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../../prisma/prisma.service';
import { sellerDisplayName } from '../seller.service';
import { ItemBreakdownService } from '../item-breakdown.service';
import { SalesCheckService, receiptOf } from '../sales-check.service';
import { squareSaleUrl } from '../square-links';
import { attributeSales, COMP_ORDER_PREFIX, type DecisionRef } from '../sales-check';
import { liveComps } from '../comps/live-comps';
import { buildRun, discountsOf, exchangedKeyOf, resolveDestination, type BuiltLine, type BuiltRun, type RunItem, type RunSeller } from './build-run';
import { buildRecipient, mapItemStatus, type PayoutMethod, type PayoutTarget } from './paypal-mapping';
import { PAYOUTS_LOCKED_MESSAGE, PayPalClient, PayPalError, type PayoutItemRequest, type PayoutItemStatus } from './paypal.client';
import { formatCents, splitCommission } from './money';
import { addressText, addressToDestination, checksToCsv, destinationToAddress, type CheckAddress } from './checks-csv';
import {
  activeKeyOf, allFinal, flagsFor, gapsForPayout, issuesBySeller, kindOf, notPaid,
  type PayoutMethodChoice, type SellerIssue,
} from './payout-flags';
import {
  TERMINAL_PAYOUT_STATUSES,
  type PayoutFlag, type PayoutLineStatus, type PayoutLineView, type PayoutRunKind, type PayoutRunView,
  type PayoutSellerChoice, type PayoutsSummaryView,
} from '../../contracts/payouts.contracts';
import type { PayoutGapSeller } from '../../contracts/payout-gaps';
import type { SalesCheckIssue } from '../../contracts/sales-check.contracts';

/**
 * Payout runs, built by hand (Plan 52).
 *
 * A run has a kind, starts empty, and staff add the sellers it pays. Until the
 * money moves, a seller's line is worked out live from the swap's sales; when
 * it moves (Send, or closing a check run) the line is frozen and never changes
 * again. The arithmetic is in build-run.ts, the flags in payout-flags.ts, and
 * PayPal's HTTP in paypal.client.ts. What's here is the order of things: who
 * may be added, what must be true before money moves, and what PayPal's
 * answers do to a run.
 */

interface SellerInfo {
  sellerId: string;
  name: string;
  business: boolean;
  method: PayoutMethodChoice;
  run: RunSeller;
  gaps: PayoutGapSeller;
  address: CheckAddress;
  verifiedEmail: string | null;
  verifiedPhone: string | null;
}

/** Everything a run's screens are worked out from, read once. */
interface Snapshot {
  swap: { id: string; title: string };
  bps: number;
  feeRate: { flatCents: number; bps: number; capCents: number };
  env: string;
  sellers: Map<string, SellerInfo>;
  built: BuiltRun;
  lineBySeller: Map<string, BuiltLine>;
  donatedItems: Set<string>;
  items: RunItem[];
  issues: Map<string, SellerIssue[]>;
  unmatched: SalesCheckIssue[];
  salesError: string | null;
  discounts: ReturnType<typeof discountsOf>['discounts'];
  /** Every comp of the swap, live or undone, for the cards (Plan 53). */
  comps: Map<string, { reason: string; note: string; live: boolean; units: number; priceCents: number }>;
}

const SELLER_SELECT = {
  id: true,
  businessName: true,
  membership: {
    select: {
      user: {
        select: {
          firstName: true, lastName: true, email: true, phone: true, emailVerifiedAt: true,
          verifiedEmail: true, verifiedPhone: true,
          payoutMethod: true, payoutTarget: true, payoutHandle: true, payoutHandleScannedAt: true,
          street: true, city: true, state: true, zip: true,
        },
      },
    },
  },
} as const;

const EMPTY_BUILT: BuiltRun = { lines: [], unmatched: [], pricesFromRegister: [], unpricedSales: [], held: [] };

@Injectable()
export class PayoutRunService {
  private readonly logger = new Logger(PayoutRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paypal: PayPalClient,
    private readonly breakdown: ItemBreakdownService,
    private readonly salesCheck: SalesCheckService,
  ) {}

  // ─── Reading ────────────────────────────────────────────────────────────────

  /** The PayPal balance a run's funding is set against (read only). */
  async paypalBalance(orgId: string) {
    return this.paypal.getBalance(orgId);
  }

  /** The Payouts page (Plan 52): the runs, and everything to fix before paying. */
  async summary(orgId: string, swapId: string): Promise<PayoutsSummaryView> {
    const snap = await this.snapshot(orgId, swapId);
    const [runs, lines] = await Promise.all([
      this.prisma.payoutRun.findMany({ where: { orgId, swapId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.payoutLine.findMany({ where: { swapId }, orderBy: { createdAt: 'asc' } }),
    ]);
    const runById = new Map(runs.map((r) => [r.id, r]));
    const active = new Set(lines.filter((l) => l.activeKey).map((l) => l.sellerId));
    const name = (id: string) => snap.sellers.get(id)?.name ?? lines.find((l) => l.sellerId === id)?.sellerName ?? 'Unnamed seller';

    const runViews = runs.map((run) => {
      const its = lines.filter((l) => l.runId === run.id);
      return {
        id: run.id,
        kind: run.kind as PayoutRunKind,
        status: run.status as 'OPEN' | 'CLOSED',
        createdAt: run.createdAt.toISOString(),
        closedAt: run.closedAt?.toISOString() ?? null,
        lineCount: its.length,
        flaggedCount: its.filter((l) => !l.frozenAt && this.flagsOf(snap, run.kind as PayoutRunKind, l.sellerId).length > 0).length,
        totalNetCents: its.reduce((n, l) => n + (l.frozenAt ? l.netCents ?? 0 : snap.lineBySeller.get(l.sellerId)?.netCents ?? 0), 0),
      };
    });

    const missingDetails = [...snap.lineBySeller.keys()].flatMap((id) => {
      const s = snap.sellers.get(id);
      if (!s || s.method === 'DONATE' || active.has(id)) return [];
      return gapsForPayout(s.gaps).slice(0, 1).map((g) => ({ sellerId: id, name: s.name, key: g.key, problem: g.problem, fix: g.fix }));
    });

    // D19: the latest line of each seller PayPal didn't pay, while they're in no other run.
    const notPaidRows = new Map<string, (typeof lines)[number]>();
    for (const l of lines) if (notPaid(l.status) && !active.has(l.sellerId)) notPaidRows.set(l.sellerId, l);

    const changedSincePaid = lines.flatMap((l) => {
      const diff = this.changedSincePaid(l, snap);
      return diff ? [{ runId: l.runId, sellerId: l.sellerId, name: l.sellerName, diffCents: diff }] : [];
    });

    const ready = { CHECK: 0, PAYPAL: 0 };
    for (const c of this.choicesOf(snap, active)) ready[kindOf(c.method)!]++;

    return {
      swapId,
      swapTitle: snap.swap.title,
      salesError: snap.salesError,
      runs: runViews,
      missingDetails,
      salesCheck: {
        bySeller: [...snap.issues].flatMap(([sellerId, list]) => list.map((i) => ({ sellerId, name: name(sellerId), sku: i.sku, text: i.text }))),
        unmatched: snap.unmatched.map((i) => ({
          receipt: i.receipt,
          soldAt: i.soldAt,
          name: i.rungUpAs?.name ?? (i.kind === 'custom_amount' ? 'Custom amount' : i.ticket ? `Ticket ${i.ticket}` : 'A sale'),
          collectedCents: i.collectedCents,
          saleUrl: i.links.sale,
        })),
      },
      notPaid: [...notPaidRows.values()].map((l) => ({
        sellerId: l.sellerId, name: name(l.sellerId), runId: l.runId,
        createdAt: runById.get(l.runId)?.createdAt.toISOString() ?? l.createdAt.toISOString(),
        status: l.status as PayoutLineStatus, reason: l.statusNote,
      })),
      changedSincePaid,
      discounts: snap.discounts
        .filter((d) => !d.exchange)
        .map((d) => ({ sku: d.sku, name: d.name, sellerName: d.sellerName, listedCents: d.listedCents, collectedCents: d.collectedCents })),
      donated: [...snap.lineBySeller.values()]
        .filter((l) => l.method === 'DONATE')
        .map((l) => ({ sellerId: l.sellerId, name: l.sellerName, items: l.items.reduce((n, i) => n + i.quantity, 0), grossCents: l.items.reduce((n, i) => n + i.priceCents * i.quantity, 0) })),
      ready,
      comps: [...snap.comps.values()].filter((c) => c.live).reduce((t, c) => ({ count: t.count + c.units, totalCents: t.totalCents + c.units * c.priceCents }), { count: 0, totalCents: 0 }),
    };
  }

  /** The sellers a run of this kind can take now (D3), for "Add sellers". */
  async choices(orgId: string, runId: string): Promise<PayoutSellerChoice[]> {
    const run = await this.runOrThrow(orgId, runId);
    const snap = await this.snapshot(orgId, run.swapId);
    const active = await this.activeSellers(run.swapId);
    const before = await this.prisma.payoutLine.findMany({ where: { swapId: run.swapId, status: { in: ['FAILED', 'RETURNED', 'CANCELLED'] } }, select: { sellerId: true } });
    const notPaidBefore = new Set(before.map((b) => b.sellerId));
    return this.choicesOf(snap, active)
      .filter((c) => kindOf(c.method) === run.kind)
      .map((c) => ({ ...c, notPaidBefore: notPaidBefore.has(c.sellerId) }));
  }

  async get(orgId: string, runId: string): Promise<PayoutRunView> {
    const run = await this.prisma.payoutRun.findFirst({
      where: { id: runId, orgId },
      include: {
        swap: { select: { title: true } },
        lines: { include: { items: { orderBy: { soldAt: 'asc' } }, notices: { where: { dayMark: 0 }, select: { createdAt: true } } } },
      },
    });
    if (!run) throw new NotFoundException('Payout run not found');
    const snap = await this.snapshot(orgId, run.swapId);
    const others = await this.prisma.payoutLine.findMany({
      where: { swapId: run.swapId, runId: { not: run.id }, sellerId: { in: run.lines.map((l) => l.sellerId) }, status: { in: ['FAILED', 'RETURNED', 'CANCELLED'] } },
      select: { sellerId: true, runId: true, status: true, statusNote: true, run: { select: { createdAt: true } } },
    });

    const lines = run.lines.map((l) => this.lineView(run.kind as PayoutRunKind, l, snap, others.filter((o) => o.sellerId === l.sellerId)));
    lines.sort((a, b) => a.sellerName.localeCompare(b.sellerName));
    const sending = run.lines.some((l) => l.status === 'SENDING');

    return {
      id: run.id,
      swapId: run.swapId,
      swapTitle: run.swap.title,
      kind: run.kind as PayoutRunKind,
      status: run.status as 'OPEN' | 'CLOSED',
      createdAt: run.createdAt.toISOString(),
      closedAt: run.closedAt?.toISOString() ?? null,
      sendingLocked: !this.paypal.sendingEnabled(),
      awaitingAnswer: run.kind === 'PAYPAL' && !run.payoutBatchId && sending,
      batch: run.payoutBatchId || run.batchReason
        ? { id: run.payoutBatchId, status: run.batchStatus, feesCents: run.paypalFeeCents, reason: run.batchReason }
        : null,
      feeRate: snap.feeRate,
      salesError: snap.salesError,
      lines,
    };
  }

  // ─── Building ───────────────────────────────────────────────────────────────

  /** An empty run of one kind (D1, D2). */
  async create(orgId: string, swapId: string, kind: PayoutRunKind, actorId: string) {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { id: true } });
    if (!swap) throw new NotFoundException('Swap not found');
    const id = createId();
    await this.prisma.payoutRun.create({ data: { id, orgId, swapId, kind, status: 'OPEN' } });
    await this.audit(orgId, actorId, 'payout_run.created', id, { kind });
    return { id };
  }

  /** Only an empty run, made by mistake (D15). */
  async remove(orgId: string, runId: string, actorId: string) {
    const run = await this.runOrThrow(orgId, runId);
    const lines = await this.prisma.payoutLine.count({ where: { runId } });
    if (lines > 0) throw new ConflictException('Only an empty run can be deleted.');
    await this.prisma.payoutRun.delete({ where: { id: run.id } });
    await this.audit(orgId, actorId, 'payout_run.deleted', runId, {});
    return { deleted: true };
  }

  /** Adds sellers, answering per seller (D3, D4). Refused once the run is sent (D18). */
  async addSellers(orgId: string, runId: string, sellerIds: string[], actorId: string) {
    const run = await this.runOrThrow(orgId, runId);
    await this.assertBuildable(run);
    const snap = await this.snapshot(orgId, run.swapId);
    const active = await this.activeSellers(run.swapId);
    const results: { sellerId: string; result: 'added' | 'in_another_run' | 'wrong_method' | 'incomplete_details' | 'nothing_owed' | 'not_found' }[] = [];

    for (const sellerId of [...new Set(sellerIds)]) {
      const s = snap.sellers.get(sellerId);
      const line = snap.lineBySeller.get(sellerId);
      if (!s) { results.push({ sellerId, result: 'not_found' }); continue; }
      if (active.has(sellerId)) { results.push({ sellerId, result: 'in_another_run' }); continue; }
      if (kindOf(s.method) !== run.kind) { results.push({ sellerId, result: 'wrong_method' }); continue; }
      if (gapsForPayout(s.gaps).length) { results.push({ sellerId, result: 'incomplete_details' }); continue; }
      if (!line || line.netCents <= 0) { results.push({ sellerId, result: 'nothing_owed' }); continue; }
      try {
        await this.prisma.payoutLine.create({
          data: {
            id: createId(), runId, swapId: run.swapId, sellerId, sellerName: s.name,
            activeKey: activeKeyOf(run.swapId, sellerId), status: 'PENDING',
          },
        });
        results.push({ sellerId, result: 'added' });
      } catch (err) {
        // The unique key: someone else added them a moment ago (D4).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          results.push({ sellerId, result: 'in_another_run' });
          continue;
        }
        throw err;
      }
    }
    await this.audit(orgId, actorId, 'payout_run.sellers_added', runId, { results });
    return { results };
  }

  /** Until their money moves (D5). The line is deleted, and they can join any run. */
  async removeSeller(orgId: string, runId: string, sellerId: string, actorId: string) {
    const run = await this.runOrThrow(orgId, runId);
    await this.assertBuildable(run);
    const line = await this.prisma.payoutLine.findFirst({ where: { runId, sellerId } });
    if (!line) throw new NotFoundException('That seller isn’t in this run.');
    if (line.frozenAt || !['PENDING', 'APPROVED'].includes(line.status)) {
      throw new ConflictException('Their money has moved, so they can’t be removed.');
    }
    await this.prisma.payoutLine.delete({ where: { id: line.id } });
    await this.audit(orgId, actorId, 'payout_line.removed', runId, { sellerId });
    return { removed: true };
  }

  // ─── Approving ──────────────────────────────────────────────────────────────

  /**
   * One seller, by hand (D7): records the total the approver saw. A flagged
   * seller can't be approved (D8).
   */
  async approve(orgId: string, runId: string, lineId: string, approved: boolean, actorId: string) {
    const run = await this.runOrThrow(orgId, runId);
    if (run.status !== 'OPEN') throw new ConflictException('This run is closed.');
    const line = await this.prisma.payoutLine.findFirst({ where: { id: lineId, runId } });
    if (!line) throw new NotFoundException('Payout line not found');
    if (line.status !== (approved ? 'PENDING' : 'APPROVED')) {
      throw new ConflictException(approved ? 'Only a seller who needs review can be approved.' : 'Only an approved seller can be unapproved.');
    }

    let approvedNetCents: number | null = null;
    if (approved) {
      const snap = await this.snapshot(orgId, run.swapId);
      if (snap.salesError) throw new BadRequestException(`Sales couldn’t be read, so there’s no total to approve: ${snap.salesError}`);
      const flags = this.flagsOf(snap, run.kind as PayoutRunKind, line.sellerId);
      if (flags.length) throw new ConflictException(`Resolve the flags first: ${flags.map((f) => f.text).join('; ')}`);
      approvedNetCents = snap.lineBySeller.get(line.sellerId)?.netCents ?? 0;
    }

    await this.prisma.payoutLine.update({
      where: { id: line.id },
      data: approved
        ? { status: 'APPROVED', approvedBy: actorId, approvedAt: new Date(), approvedNetCents, statusNote: null }
        : { status: 'PENDING', approvedBy: null, approvedAt: null, approvedNetCents: null },
    });
    await this.audit(orgId, actorId, approved ? 'payout_line.approved' : 'payout_line.unapproved', runId, { lineId, approvedNetCents });
    return { status: approved ? 'APPROVED' : 'PENDING', approvedNetCents };
  }

  // ─── Paying ─────────────────────────────────────────────────────────────────

  /**
   * Hands the run to PayPal: once (D18).
   *
   * The one-way door. Lines move to SENDING *before* the call and never move
   * back on their own, because the failure that matters is not "the batch was
   * rejected" — it is "we do not know whether it was". A line sitting in
   * SENDING is a question for a person; a line that quietly returned to
   * APPROVED is a second payment waiting to happen.
   */
  async send(orgId: string, runId: string, expectedLineCount: number, actorId: string) {
    const run = await this.runOrThrow(orgId, runId);
    if (run.kind !== 'PAYPAL') throw new BadRequestException('A check run isn’t sent: close and export it.');
    if (run.status !== 'OPEN') throw new ConflictException('This run is closed.');
    if (run.payoutBatchId) throw new ConflictException('This run was already sent. A run is sent once.');
    // The server's lock (fail closed): refused before any line moves, so a
    // locked send leaves the run exactly as it was.
    if (!this.paypal.sendingEnabled()) {
      throw new ForbiddenException({ code: 'PAYOUTS_LOCKED', message: PAYOUTS_LOCKED_MESSAGE });
    }

    // A resume rather than a new send. Lines left in SENDING mean a previous
    // attempt did not come back, so this re-posts the *same* sender_batch_id:
    // PayPal dedupes it for thirty days and returns the batch it already has.
    // Bumping the attempt here is precisely how a double payment happens.
    const inFlight = await this.prisma.payoutLine.count({ where: { runId, status: 'SENDING' } });
    const attempt = inFlight > 0 ? run.sendAttempt : run.sendAttempt + 1;

    if (inFlight === 0) {
      const lines = await this.prisma.payoutLine.findMany({ where: { runId } });
      if (lines.some((l) => l.status === 'PENDING')) throw new BadRequestException('Approve every seller in the run first.');
      const approved = lines.filter((l) => l.status === 'APPROVED');
      // The screen said one number and the server holds another: somebody
      // approved or unapproved a line between looking and clicking.
      if (approved.length !== expectedLineCount) {
        throw new ConflictException(`This run now has ${approved.length} approved payouts, not ${expectedLineCount}. Review it again.`);
      }
      if (approved.length === 0) throw new BadRequestException('No approved payouts to send');

      const snap = await this.freshSnapshot(orgId, run.swapId);
      await this.recheck(run, approved, snap);

      // D17: Send waits for the money, when PayPal says what it holds.
      const balance = await this.paypal.getBalance(orgId);
      if (balance.availableCents !== null) {
        const needed = approved.reduce((n, l) => n + l.approvedNetCents! + feeCents(l.approvedNetCents!, snap.feeRate), 0);
        if (balance.availableCents < needed) {
          throw new BadRequestException(`PayPal holds ${formatCents(balance.availableCents)}, short of the ${formatCents(needed)} this run needs. Add money to PayPal first.`);
        }
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.payoutRun.update({ where: { id: runId }, data: { sendAttempt: attempt, batchReason: null } });
        for (const l of approved) {
          await this.freeze(tx, l.id, snap, l.sellerId, 'SENDING');
        }
      });
    }

    const lines = await this.prisma.payoutLine.findMany({ where: { runId, status: 'SENDING' } });
    const senderBatchId = `${runId}-${attempt}`;
    const items: PayoutItemRequest[] = [];
    for (const line of lines) {
      if (!line.destination || !line.method || line.netCents === null) {
        // Cannot happen for a line that reached APPROVED, but a payout batch is
        // the wrong place to discover it if it does.
        await this.endLine(line.id, 'FAILED', 'No destination — this line was approved without one');
        continue;
      }
      items.push({
        senderItemId: line.id,
        amountCents: line.netCents,
        recipient: buildRecipient(line.method as PayoutMethod, line.destinationType as PayoutTarget | null, line.destination),
        note: `Ski swap payout — ${formatCents(line.netCents)}`,
      });
    }
    if (!items.length) throw new BadRequestException('No sendable payouts in this run');

    await this.audit(orgId, actorId, 'payout_run.sent', runId, {
      senderBatchId, count: items.length, totalCents: items.reduce((s, i) => s + i.amountCents, 0),
    });

    let result;
    try {
      result = await this.paypal.createBatch(orgId, senderBatchId, items);
    } catch (err) {
      if (err instanceof PayPalError && !err.retryable) {
        // D19: refused outright. Nothing was queued and nothing moved, so
        // everyone goes back to approved, unfrozen, to Send again.
        const reason = `PayPal refused the batch: ${err.message}`;
        await this.prisma.$transaction(async (tx) => {
          const sendingIds = (await tx.payoutLine.findMany({ where: { runId, status: 'SENDING' }, select: { id: true } })).map((l) => l.id);
          await tx.payoutLineItem.deleteMany({ where: { lineId: { in: sendingIds } } });
          await tx.payoutLine.updateMany({ where: { id: { in: sendingIds } }, data: { status: 'APPROVED', ...UNFROZEN } });
          await tx.payoutRun.update({ where: { id: runId }, data: { batchReason: reason } });
        });
        throw new BadRequestException(`${reason}. Nothing was paid.`);
      }
      // Anything else — a 5xx, a timeout, a dropped socket — leaves the lines
      // in SENDING on purpose. Sending again re-posts the same batch id, which
      // PayPal will not honour twice.
      this.logger.error({ runId, senderBatchId, err }, 'Payout batch did not come back');
      throw new ConflictException('PayPal did not answer. The payouts are marked as sending; use Send again to retry safely.');
    }

    await this.prisma.payoutRun.update({
      where: { id: runId },
      data: { payoutBatchId: result.batchId || null, batchStatus: result.batchStatus || null, paypalFeeCents: result.feesCents ?? null },
    });
    await this.applyBatchResult(result.batchId, result.items, { batchStatus: result.batchStatus, feesCents: result.feesCents });
    return this.get(orgId, runId);
  }

  /**
   * A check run: freezes everyone and closes it, for the spreadsheet the checks
   * are written from (D13). The same all-or-nothing check as Send (D7).
   */
  async closeChecks(orgId: string, runId: string, expectedLineCount: number, actorId: string) {
    const run = await this.runOrThrow(orgId, runId);
    if (run.kind !== 'CHECK') throw new BadRequestException('Only a check run is closed and exported.');
    if (run.status !== 'OPEN') throw new ConflictException('This run is already closed.');
    const lines = await this.prisma.payoutLine.findMany({ where: { runId } });
    if (lines.some((l) => l.status === 'PENDING')) throw new BadRequestException('Approve every seller in the run first.');
    const approved = lines.filter((l) => l.status === 'APPROVED');
    if (approved.length !== expectedLineCount) {
      throw new ConflictException(`This run now has ${approved.length} approved checks, not ${expectedLineCount}. Review it again.`);
    }
    if (approved.length === 0) throw new BadRequestException('No approved checks to export');

    const snap = await this.freshSnapshot(orgId, run.swapId);
    await this.recheck(run, approved, snap);

    await this.prisma.$transaction(async (tx) => {
      for (const l of approved) await this.freeze(tx, l.id, snap, l.sellerId, 'EXPORTED');
      await tx.payoutRun.update({ where: { id: runId }, data: { status: 'CLOSED', closedAt: new Date(), closedBy: actorId } });
    });
    await this.audit(orgId, actorId, 'payout_run.closed_and_exported', runId, {
      checks: approved.length, totalCents: approved.reduce((n, l) => n + (l.approvedNetCents ?? 0), 0),
    });
    return this.get(orgId, runId);
  }

  /** The closed check run's spreadsheet (D13). */
  async checksCsv(orgId: string, runId: string): Promise<string> {
    const run = await this.prisma.payoutRun.findFirst({
      where: { id: runId, orgId },
      include: { swap: { select: { title: true } }, lines: { where: { status: 'EXPORTED' }, include: { items: { select: { quantity: true } } }, orderBy: { sellerName: 'asc' } } },
    });
    if (!run) throw new NotFoundException('Payout run not found');
    if (run.kind !== 'CHECK' || run.status !== 'CLOSED') throw new BadRequestException('Close and export the check run first.');
    return checksToCsv(run.lines.map((l) => {
      const items = l.items.reduce((n, i) => n + i.quantity, 0);
      return {
        payee: l.sellerName,
        ...destinationToAddress(l.destination),
        amountCents: l.netCents ?? 0,
        memo: `${run.swap.title} payout: ${items} ${items === 1 ? 'item' : 'items'}`,
        date: l.frozenAt ?? run.closedAt ?? new Date(),
      };
    }));
  }

  /** A change after payment, settled outside PatrolKit (D9). */
  async settle(orgId: string, runId: string, lineId: string, note: string, actorId: string) {
    const line = await this.prisma.payoutLine.findFirst({ where: { id: lineId, runId, run: { orgId } } });
    if (!line) throw new NotFoundException('Payout line not found');
    if (!['SENT', 'EXPORTED'].includes(line.status)) throw new ConflictException('Only a paid seller’s change is settled.');
    await this.prisma.payoutLine.update({ where: { id: lineId }, data: { settledAt: new Date(), settledBy: actorId, settledNote: note } });
    await this.audit(orgId, actorId, 'payout_line.settled', runId, { lineId, note });
    return { settled: true };
  }

  /**
   * An unclaimed payment, cancelled at PayPal (D19): the money comes back now,
   * and the line is marked Cancelled. Final in this run; the seller is paid
   * from another.
   */
  async cancelPayment(orgId: string, runId: string, lineId: string, actorId: string) {
    const line = await this.prisma.payoutLine.findFirst({ where: { id: lineId, runId, run: { orgId } } });
    if (!line) throw new NotFoundException('Payout line not found');
    if (line.status !== 'UNCLAIMED' || !line.payoutItemId) throw new ConflictException('Only an unclaimed payment can be cancelled.');
    // Cancelling is a write to PayPal too, so the server's lock holds it.
    if (!this.paypal.sendingEnabled()) {
      throw new ForbiddenException({ code: 'PAYOUTS_LOCKED', message: PAYOUTS_LOCKED_MESSAGE });
    }
    await this.paypal.cancelItem(orgId, line.payoutItemId);
    await this.endLine(lineId, 'CANCELLED', 'Cancelled at PayPal; the money came back.');
    await this.audit(orgId, actorId, 'payout_line.cancelled', runId, { lineId });
    await this.closeIfDone(runId);
    return { cancelled: true };
  }

  // ─── PayPal's answers ──────────────────────────────────────────────────────

  /**
   * Writes PayPal's view of a batch onto our lines.
   *
   * Shared by the send, the webhook and the sweep, so all three can only ever
   * disagree by being run at different times — never by reading the same answer
   * two ways. A batch PayPal denies fails everyone in it (D19); a run whose
   * payments are all final closes (D15).
   */
  async applyBatchResult(batchId: string, items: PayoutItemStatus[], header?: { batchStatus?: string; feesCents?: number }) {
    const runIds = new Set<string>();
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
      const ended = notPaid(mapped.status);
      const res = await this.prisma.payoutLine.updateMany({
        // Never overwrite a line that has already arrived somewhere final. A
        // late webhook must not walk SENT backwards.
        where: { id: item.senderItemId, status: { notIn: [...TERMINAL_PAYOUT_STATUSES] } },
        data: {
          status: mapped.status,
          statusNote: item.errorMessage ?? mapped.note ?? null,
          payoutBatchId: batchId || undefined,
          payoutItemId: item.payoutItemId || undefined,
          transactionId: item.transactionId || undefined,
          ...(mapped.status === 'SENT' ? { sentAt: new Date() } : {}),
          // D4: a payment that didn't pay them frees them for another run.
          ...(ended ? { activeKey: null } : {}),
        },
      });
      if (res.count) {
        const line = await this.prisma.payoutLine.findUnique({ where: { id: item.senderItemId }, select: { runId: true } });
        if (line) runIds.add(line.runId);
      }
    }

    if (batchId && header?.batchStatus) {
      const run = await this.prisma.payoutRun.findFirst({ where: { payoutBatchId: batchId } });
      if (run) {
        runIds.add(run.id);
        const denied = header.batchStatus === 'DENIED' || header.batchStatus === 'CANCELED';
        await this.prisma.payoutRun.update({
          where: { id: run.id },
          data: {
            batchStatus: header.batchStatus,
            ...(header.feesCents !== undefined ? { paypalFeeCents: header.feesCents } : {}),
            ...(denied ? { batchReason: `PayPal ${header.batchStatus === 'DENIED' ? 'denied' : 'cancelled'} the whole batch.` } : {}),
          },
        });
        // D19: the whole batch, so the whole run, failed. Nobody in it was paid.
        if (denied) {
          await this.prisma.payoutLine.updateMany({
            where: { runId: run.id, status: { notIn: [...TERMINAL_PAYOUT_STATUSES] } },
            data: { status: 'FAILED', statusNote: 'PayPal refused the whole batch.', activeKey: null },
          });
        }
      }
    }

    for (const runId of runIds) await this.closeIfDone(runId);
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
    await this.applyBatchResult(result.batchId || batchId, result.items, { batchStatus: result.batchStatus, feesCents: result.feesCents });
    return { batchId, items: result.items.length };
  }

  /** "Check with PayPal" on one run. */
  async reconcileRun(orgId: string, runId: string) {
    const run = await this.runOrThrow(orgId, runId);
    if (!run.payoutBatchId) return this.get(orgId, runId);
    await this.reconcileBatch(orgId, run.payoutBatchId);
    return this.get(orgId, runId);
  }

  /**
   * Re-reads every batch this org has a payment still moving in.
   *
   * Cheap and idempotent: `applyBatchResult` refuses to walk a terminal status
   * backwards, so running it twice in a row changes nothing the second time.
   */
  async reconcileOrg(orgId: string) {
    const rows = await this.prisma.payoutRun.findMany({
      where: { orgId, payoutBatchId: { not: null }, lines: { some: { status: { in: ['SENDING', 'UNCLAIMED', 'ONHOLD'] } } } },
      select: { payoutBatchId: true },
    });
    let reconciled = 0;
    for (const row of rows) {
      try {
        await this.reconcileBatch(orgId, row.payoutBatchId!);
        reconciled++;
      } catch (err) {
        // One unreadable batch must not stop the rest. The line stays where it
        // is and comes round again on the next sweep.
        this.logger.error({ orgId, batchId: row.payoutBatchId, err }, 'Could not reconcile batch');
      }
    }
    return { batches: rows.length, reconciled };
  }

  // ─── Plumbing ───────────────────────────────────────────────────────────────

  /** What a run's screens are worked out from: sales, sellers, Sales check (D6, D8). */
  private async snapshot(orgId: string, swapId: string): Promise<Snapshot> {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { id: true, title: true } });
    if (!swap) throw new NotFoundException('Swap not found');
    const [settings, square, itemRows, decisions, exchanges, comps] = await Promise.all([
      this.prisma.skiSwapSettings.findUnique({ where: { orgId } }),
      this.prisma.squareConfig.findUnique({ where: { orgId }, select: { environment: true } }),
      // Tombstones included, deliberately: an item can sell and be deleted
      // afterwards, and the sale still happened. A deleted item that never
      // sold matches nothing and owes nothing.
      this.prisma.swapItem.findMany({
        where: { swapId },
        select: { id: true, name: true, sku: true, priceCents: true, squareVariationId: true, donateProceeds: true, sellerId: true, originalQuantity: true },
      }),
      this.prisma.swapSaleDecision.findMany({ where: { swapId, liveKey: { not: null } }, select: { orderId: true, lineUid: true, decision: true, itemId: true } }),
      this.prisma.swapExchange.findMany({ where: { swapId, liveKey: { not: null } }, select: { orderId: true, lineUid: true, replacementItemId: true } }),
      liveComps(this.prisma, swapId),
    ]);
    const compRows = await this.prisma.swapComp.findMany({ where: { swapId }, select: { id: true, reason: true, note: true, liveKey: true, units: true, priceCents: true } });
    const bps = settings?.commissionBasisPoints ?? 0;
    const feeRate = { flatCents: settings?.paypalFeeFlatCents ?? 25, bps: settings?.paypalFeeBps ?? 0, capCents: settings?.paypalFeeCapCents ?? 0 };

    const lineSellers = await this.prisma.payoutLine.findMany({ where: { swapId }, select: { sellerId: true }, distinct: ['sellerId'] });
    const sellerIds = [...new Set([...itemRows.map((i) => i.sellerId), ...lineSellers.map((l) => l.sellerId)].filter((id): id is string => !!id))];
    const sellerRows = await this.prisma.sellerProfile.findMany({ where: { id: { in: sellerIds } }, select: SELLER_SELECT });
    const sellers = new Map<string, SellerInfo>(sellerRows.map((s) => [s.id, sellerInfo(s)]));

    let built = EMPTY_BUILT;
    let salesError: string | null = null;
    try {
      const raw = await this.breakdown.rawSales(orgId, swapId);
      const sales = attributeSales(
        raw.lines,
        decisions as DecisionRef[],
        exchanges,
        new Set(itemRows.map((i) => i.squareVariationId).filter((v): v is string => !!v)),
        new Map(itemRows.filter((i) => i.squareVariationId).map((i) => [i.id, i.squareVariationId!])),
        comps,
      );
      built = buildRun(itemRows, [...sellers.values()].map((s) => s.run), sales, { commissionBasisPoints: bps });
    } catch (err) {
      salesError = err instanceof Error ? err.message : 'Square couldn’t be read.';
    }

    let issues = new Map<string, SellerIssue[]>();
    let unmatched: SalesCheckIssue[] = [];
    if (!salesError) {
      try {
        const check = await this.salesCheck.list(orgId, swapId);
        if (check.error) salesError = check.error;
        ({ bySeller: issues, unmatched } = issuesBySeller(check.issues, itemRows));
      } catch (err) {
        this.logger.warn({ swapId, err }, 'Sales check couldn’t be read for payouts');
        salesError = 'Sales check couldn’t be read, so its issues aren’t shown.';
      }
    }

    const exchangedKeys = new Set(exchanges.map((e) => exchangedKeyOf(e.replacementItemId, e.orderId)));
    return {
      swap,
      bps,
      feeRate,
      env: square?.environment ?? 'production',
      sellers,
      built,
      lineBySeller: new Map(built.lines.map((l) => [l.sellerId, l])),
      donatedItems: new Set(itemRows.filter((i) => i.donateProceeds).map((i) => i.id)),
      items: itemRows,
      issues,
      unmatched,
      salesError,
      discounts: discountsOf(built.lines, exchangedKeys).discounts,
      comps: new Map(compRows.map((c) => [c.id, { reason: c.reason, note: c.note, live: !!c.liveKey, units: c.units, priceCents: c.priceCents }])),
    };
  }

  /** Square read afresh, for the moment money moves (D7). */
  private async freshSnapshot(orgId: string, swapId: string): Promise<Snapshot> {
    this.breakdown.forgetSales(swapId);
    const snap = await this.snapshot(orgId, swapId);
    if (snap.salesError) throw new BadRequestException(`Sales couldn’t be read, so nothing was paid: ${snap.salesError}`);
    return snap;
  }

  /**
   * D7: every approved seller's total, fresh, against what was approved, and
   * no flags. Anything off stops the whole run: the changed sellers' approvals
   * are cleared and nothing moves.
   */
  private async recheck(run: { id: string; kind: string }, approved: { id: string; sellerId: string; approvedNetCents: number | null; sellerName: string }[], snap: Snapshot) {
    const flagged = approved.filter((l) => this.flagsOf(snap, run.kind as PayoutRunKind, l.sellerId).length > 0);
    const changed = approved.filter((l) => (snap.lineBySeller.get(l.sellerId)?.netCents ?? 0) !== l.approvedNetCents);
    const verb = run.kind === 'CHECK' ? 'Not closed' : 'Not sent';
    if (changed.length) {
      for (const l of changed) {
        const now = snap.lineBySeller.get(l.sellerId)?.netCents ?? 0;
        await this.prisma.payoutLine.update({
          where: { id: l.id },
          data: {
            status: 'PENDING', approvedBy: null, approvedAt: null, approvedNetCents: null,
            statusNote: `Changed since approved: was ${formatCents(l.approvedNetCents ?? 0)}, now ${formatCents(now)}. Review again.`,
          },
        });
      }
      throw new ConflictException(`${verb}: ${changed.length} ${changed.length === 1 ? 'seller' : 'sellers'} changed since approval. Their approvals were cleared; the others stay approved.`);
    }
    if (flagged.length) {
      throw new ConflictException(`${verb}: ${flagged.map((l) => l.sellerName).join(', ')} ${flagged.length === 1 ? 'has' : 'have'} a flag to resolve first.`);
    }
  }

  /** Freezes a line as it stands now, items included (D6). */
  private async freeze(tx: Prisma.TransactionClient, lineId: string, snap: Snapshot, sellerId: string, status: PayoutLineStatus) {
    const s = snap.sellers.get(sellerId)!;
    const built = snap.lineBySeller.get(sellerId)!;
    const check = s.method === 'CHECK';
    const { destination, destinationType } = check ? { destination: addressToDestination(s.address), destinationType: null } : resolveDestination(s.run);
    await tx.payoutLineItem.deleteMany({ where: { lineId } });
    await tx.payoutLine.update({
      where: { id: lineId },
      data: {
        status, sellerName: s.name, method: s.method, destination, destinationType,
        grossCents: built.grossCents, commissionCents: built.commissionCents, netCents: built.netCents,
        commissionBasisPoints: snap.bps, frozenAt: new Date(),
      },
    });
    await tx.payoutLineItem.createMany({
      data: built.items.map((i) => ({
        id: createId(), lineId, itemId: i.itemId, name: i.name, sku: i.sku, priceCents: i.priceCents,
        quantity: i.quantity, collectedCents: i.collectedCents, squareOrderId: i.squareOrderId, soldAt: i.soldAt,
        refundedQty: i.refundedQty, paymentId: i.paymentId, lineUid: i.lineUid,
      })),
    });
  }

  /** A payment that ended without paying them: final, and it frees the seller (D4, D19). */
  private async endLine(lineId: string, status: 'FAILED' | 'CANCELLED', note: string) {
    await this.prisma.payoutLine.update({ where: { id: lineId }, data: { status, statusNote: note, activeKey: null } });
  }

  /** D15: a PayPal run closes once every payment is final. */
  private async closeIfDone(runId: string) {
    const run = await this.prisma.payoutRun.findUnique({ where: { id: runId }, include: { lines: { select: { status: true } } } });
    if (!run || run.kind !== 'PAYPAL' || run.status !== 'OPEN') return;
    if (!allFinal(run.lines.map((l) => l.status))) return;
    await this.prisma.payoutRun.update({ where: { id: runId }, data: { status: 'CLOSED', closedAt: new Date() } });
    await this.prisma.auditLog.create({
      data: { actorType: 'system', actorId: 'paypal', orgId: run.orgId, action: 'payout_run.closed', targetType: 'payout_run', targetId: runId, metadata: { reason: 'every payment final' } },
    });
  }

  /** Sellers can be added and removed only before the run is sent (D18). */
  private async assertBuildable(run: { id: string; status: string; payoutBatchId: string | null }) {
    if (run.status !== 'OPEN') throw new ConflictException('This run is closed.');
    const sending = await this.prisma.payoutLine.count({ where: { runId: run.id, status: { notIn: ['PENDING', 'APPROVED'] } } });
    if (run.payoutBatchId || sending) throw new ConflictException('This run was sent, so it takes no more changes.');
  }

  private flagsOf(snap: Snapshot, kind: PayoutRunKind, sellerId: string): PayoutFlag[] {
    const s = snap.sellers.get(sellerId);
    if (!s) return [{ text: 'Seller not found', fix: 'Remove them from the run.' }];
    if (snap.salesError) return [];
    return flagsFor({
      kind,
      method: s.method,
      gaps: gapsForPayout(s.gaps),
      issues: snap.issues.get(sellerId) ?? [],
      unpriced: snap.built.unpricedSales.filter((u) => u.sellerId === sellerId).map((u) => u.sku),
      held: snap.built.held.filter((h) => h.sellerId === sellerId).map((h) => h.sku),
      netCents: snap.lineBySeller.get(sellerId)?.netCents ?? 0,
    });
  }

  /** Sellers a run could take now: complete details, something owed, in no run (D3). */
  private choicesOf(snap: Snapshot, active: Set<string>): PayoutSellerChoice[] {
    const out: PayoutSellerChoice[] = [];
    for (const [sellerId, line] of snap.lineBySeller) {
      const s = snap.sellers.get(sellerId);
      const kind = s ? kindOf(s.method) : null;
      if (!s || !kind || active.has(sellerId) || line.netCents <= 0 || gapsForPayout(s.gaps).length) continue;
      out.push({
        sellerId,
        name: s.name,
        business: s.business,
        method: s.method!,
        destination: kind === 'CHECK' ? addressText(s.address) : resolveDestination(s.run).destination,
        items: line.items.reduce((n, i) => n + i.quantity, 0),
        netCents: line.netCents,
        flags: this.flagsOf(snap, kind, sellerId),
        notPaidBefore: false,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async activeSellers(swapId: string): Promise<Set<string>> {
    const rows = await this.prisma.payoutLine.findMany({ where: { swapId, activeKey: { not: null } }, select: { sellerId: true } });
    return new Set(rows.map((r) => r.sellerId));
  }

  /** D9: live net minus what was paid, for a paid line not yet settled. */
  private changedSincePaid(l: { status: string; frozenAt: Date | null; settledAt: Date | null; netCents: number | null; sellerId: string }, snap: Snapshot): number {
    if (!l.frozenAt || l.settledAt || !['SENT', 'EXPORTED'].includes(l.status) || snap.salesError) return 0;
    return (snap.lineBySeller.get(l.sellerId)?.netCents ?? 0) - (l.netCents ?? 0);
  }

  private lineView(
    kind: PayoutRunKind,
    l: Prisma.PayoutLineGetPayload<{ include: { items: true; notices: { select: { createdAt: true } } } }>,
    snap: Snapshot,
    others: { runId: string; status: string; statusNote: string | null; run: { createdAt: Date } }[],
  ): PayoutLineView {
    const s = snap.sellers.get(l.sellerId);
    const built = snap.lineBySeller.get(l.sellerId);
    const frozen = !!l.frozenAt;
    // A comp has no receipt or Square sale to link to; it says why it was comped (Plan 53).
    const saleRefs = (orderId: string, paymentId: string | null) => {
      const compId = orderId.startsWith(COMP_ORDER_PREFIX) ? orderId.slice(COMP_ORDER_PREFIX.length) : null;
      if (compId) {
        const c = snap.comps.get(compId);
        return { receipt: null, saleUrl: null, comp: { reason: c?.reason ?? 'OTHER', note: c?.note ?? '' } };
      }
      return { receipt: receiptOf(paymentId), saleUrl: squareSaleUrl(snap.env, orderId, paymentId), comp: null };
    };

    const items = frozen
      ? l.items.map((i) => ({
          itemId: i.itemId, sku: i.sku, name: i.name, priceCents: i.priceCents, quantity: i.quantity, collectedCents: i.collectedCents,
          donated: !!i.itemId && snap.donatedItems.has(i.itemId), soldAt: i.soldAt.toISOString(),
          ...saleRefs(i.squareOrderId, i.paymentId),
        }))
      : (built?.items ?? []).map((i) => ({
          itemId: i.itemId, sku: i.sku, name: i.name, priceCents: i.priceCents, quantity: i.quantity, collectedCents: i.collectedCents,
          donated: snap.donatedItems.has(i.itemId), soldAt: i.soldAt.toISOString(),
          ...saleRefs(i.squareOrderId, i.paymentId),
        }));
    const count = items.reduce((n, i) => n + i.quantity, 0);
    const totals = frozen
      ? { items: count, grossCents: l.grossCents ?? 0, commissionCents: l.commissionCents ?? 0, netCents: l.netCents ?? 0 }
      : built
        ? { items: count, grossCents: built.grossCents, commissionCents: built.commissionCents, netCents: built.netCents }
        : { items: 0, ...splitCommission(0, snap.bps) };

    const method = frozen ? l.method : s?.method ?? null;
    const destination = frozen
      ? (l.method === 'CHECK' ? addressText(destinationToAddress(l.destination)) : l.destination)
      : s ? (s.method === 'CHECK' ? addressText(s.address) : resolveDestination(s.run).destination) : null;

    return {
      id: l.id,
      sellerId: l.sellerId,
      sellerName: frozen ? l.sellerName : s?.name ?? l.sellerName,
      business: s?.business ?? false,
      method,
      destination,
      status: l.status as PayoutLineStatus,
      statusNote: l.statusNote,
      frozen,
      frozenAt: l.frozenAt?.toISOString() ?? null,
      commissionBasisPoints: frozen ? l.commissionBasisPoints ?? snap.bps : snap.bps,
      totals,
      items,
      flags: frozen ? [] : this.flagsOf(snap, kind, l.sellerId),
      approvedNetCents: l.approvedNetCents,
      changedSincePaidCents: this.changedSincePaid(l, snap),
      settled: l.settledAt ? { note: l.settledNote ?? '', at: l.settledAt.toISOString(), by: l.settledBy } : null,
      paypal: l.payoutItemId || l.transactionId ? { itemId: l.payoutItemId, transactionId: l.transactionId, paidAt: l.sentAt?.toISOString() ?? null } : null,
      notPaidBefore: others.map((o) => ({ runId: o.runId, createdAt: o.run.createdAt.toISOString(), status: o.status as PayoutLineStatus, reason: o.statusNote })),
      remindedAt: l.notices[0]?.createdAt.toISOString() ?? null,
    };
  }

  private async runOrThrow(orgId: string, runId: string) {
    const run = await this.prisma.payoutRun.findFirst({ where: { id: runId, orgId } });
    if (!run) throw new NotFoundException('Payout run not found');
    return run;
  }

  private async audit(orgId: string, actorId: string, action: string, runId: string, metadata: Record<string, unknown>) {
    await this.prisma.auditLog.create({
      data: { actorType: 'user', actorId, orgId, action, targetType: 'payout_run', targetId: runId, metadata: metadata as never },
    });
  }
}

/** The frozen fields, cleared: a line PayPal refused at Send is live again (D19). */
const UNFROZEN = {
  frozenAt: null, grossCents: null, commissionCents: null, netCents: null, commissionBasisPoints: null,
  method: null, destination: null, destinationType: null,
} as const;

/** One payment's PayPal fee: the flat part, plus the percentage (rounded half up) up to the cap (D17). */
export function feeCents(netCents: number, rate: { flatCents: number; bps: number; capCents: number }): number {
  return rate.flatCents + Math.min(Math.round((netCents * rate.bps) / 10_000), rate.capCents);
}

function sellerInfo(s: Prisma.SellerProfileGetPayload<{ select: typeof SELLER_SELECT }>): SellerInfo {
  const u = s.membership.user;
  const method = (u.payoutMethod as PayoutMethodChoice) ?? null;
  const name = sellerDisplayName({ businessName: s.businessName, membership: { user: u } }) ?? 'Unnamed seller';
  return {
    sellerId: s.id,
    name,
    business: !!s.businessName,
    method,
    run: {
      sellerId: s.id,
      name,
      // No method is treated as a check for the arithmetic only: such a seller
      // is never offered to a run (D16).
      method: (method ?? 'CHECK') as PayoutMethod,
      target: (u.payoutTarget as PayoutTarget | null) ?? null,
      handle: u.payoutHandle,
      handleScanned: u.payoutHandleScannedAt !== null,
      verifiedEmail: u.verifiedEmail,
      verifiedPhone: u.verifiedPhone,
    },
    gaps: {
      email: u.email,
      emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null,
      street: u.street, city: u.city, state: u.state, zip: u.zip,
      payoutMethod: method,
      payoutTarget: (u.payoutTarget as PayoutGapSeller['payoutTarget']) ?? null,
      payoutHandleScanned: u.payoutHandleScannedAt !== null,
    },
    address: { street: u.street, city: u.city, state: u.state, zip: u.zip },
    verifiedEmail: u.verifiedEmail,
    verifiedPhone: u.verifiedPhone,
  };
}
