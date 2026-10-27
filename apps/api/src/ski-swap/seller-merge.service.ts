import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipTouchService } from '../common/identity/membership-touch.service';
import { displayName } from '../common/util/person';
import { addressText } from './payouts/checks-csv';
import { runLabel } from './payouts/payouts-export';
import type {
  SellerMergeChoices,
  SellerMergeLine,
  SellerMergeLineEffect,
  SellerMergePreviewResponse,
  SellerMergeResult,
  SellerMergeSide,
} from '../contracts/seller-merge.contracts';

/** A payout line whose money has moved, or is moving: the other seller's stops the merge (D4). */
const MONEY_MOVED = ['SENDING', 'SENT', 'UNCLAIMED', 'ONHOLD', 'EXPORTED'];
/** Paid nothing: kept with the retired seller as history. */
const PAID_NOTHING = ['FAILED', 'RETURNED', 'CANCELLED'];

const SELLER = {
  membership: { include: { user: true } },
} as const;

type Seller = Prisma.SellerProfileGetPayload<{ include: typeof SELLER }>;
type User = Seller['membership']['user'];

/**
 * Merging two seller records that are one seller (Plan 57).
 *
 * One is kept and one retired. Everything the retired seller holds moves to the
 * kept one: items (and through them every sale, decision, comp and exchange),
 * receipts, print jobs and printer assignments. The retired record stays as a
 * tombstone that points at the kept one, so writes still naming it land there.
 * Money that has moved under the retired record stops the merge (D4).
 */
@Injectable()
export class SellerMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly touch: MembershipTouchService,
  ) {}

  async preview(orgId: string, keepId: string, otherId: string): Promise<SellerMergePreviewResponse> {
    const { keep, other } = await this.load(orgId, keepId, otherId);

    const [keepItems, otherItems, receipts, printJobs, printers, lines] = await Promise.all([
      this.prisma.swapItem.groupBy({ by: ['swapId'], where: { sellerId: keep.id, deletedAt: null }, _count: true }),
      this.prisma.swapItem.groupBy({ by: ['swapId'], where: { sellerId: other.id, deletedAt: null }, _count: true }),
      this.prisma.receipt.count({ where: { sellerId: other.id } }),
      this.prisma.printJob.count({ where: { sellerId: other.id } }),
      this.prisma.swapPrinter.count({ where: { assignedSellerId: other.id } }),
      this.prisma.payoutLine.findMany({
        where: { sellerId: { in: [keep.id, other.id] } },
        include: { run: { select: { id: true, kind: true, status: true, createdAt: true, swapId: true, swap: { select: { title: true, timeZone: true } } } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const otherItemsTotal = await this.prisma.swapItem.count({ where: { sellerId: other.id } });

    const swapIds = [...new Set([...keepItems, ...otherItems].map((g) => g.swapId))];
    const swaps = await this.prisma.skiSwap.findMany({ where: { id: { in: swapIds } }, select: { id: true, title: true } });
    const itemsBySwap = swapIds.map((swapId) => ({
      swapId,
      title: swaps.find((s) => s.id === swapId)?.title ?? 'A swap',
      keep: keepItems.find((g) => g.swapId === swapId)?._count ?? 0,
      other: otherItems.find((g) => g.swapId === swapId)?._count ?? 0,
    }));

    const payoutLines: SellerMergeLine[] = lines.map((l) => ({
      lineId: l.id,
      runId: l.runId,
      runLabel: `${runLabel(l.run, l.run.swap.timeZone)} (${l.run.swap.title})`,
      seller: l.sellerId === keep.id ? 'keep' : 'other',
      status: l.status,
      effect: lineEffect(l, l.sellerId === keep.id, l.run.status === 'OPEN'),
    }));

    // Swaps where the kept seller has been paid and the other has items: those
    // items will read "Changed since paid", to settle by hand.
    const otherSwaps = new Set(otherItems.map((g) => g.swapId));
    const paidSwaps = [...new Set(lines
      .filter((l) => l.sellerId === keep.id && MONEY_MOVED.includes(l.status) && otherSwaps.has(l.run.swapId))
      .map((l) => l.run.swap.title))];

    const refusals: string[] = [];
    const blocking = payoutLines.filter((l) => l.effect === 'blocks');
    if (blocking.length) {
      refusals.push(
        `${displayOf(other)} has been paid, or is being paid, in ${blocking.map((l) => l.runLabel).join(', ')}. ` +
        'Moving their items would pay them twice, so settle by hand instead.',
      );
    }

    const payout = payoutChoice(keep.membership.user, other.membership.user);
    return {
      keep: side(keep, sum(keepItems)),
      other: side(other, sum(otherItems)),
      suggestedKeepId: suggestKeep(keep, other),
      moves: { items: otherItemsTotal, receipts, printJobs, printers },
      itemsBySwap,
      payoutLines,
      choices: {
        address: { keep: addressOf(keep.membership.user), other: addressOf(other.membership.user), offered: !!addressOf(other.membership.user) },
        payout,
        businessName: { keep: keep.businessName, other: other.businessName },
      },
      paidSwaps,
      refusals,
      expected: { items: otherItemsTotal, payoutLines: lines.length },
    };
  }

  async merge(
    orgId: string,
    keepId: string,
    otherId: string,
    choices: SellerMergeChoices,
    expected: { items: number; payoutLines: number },
    actorId: string,
  ): Promise<SellerMergeResult> {
    const preview = await this.preview(orgId, keepId, otherId);
    if (preview.refusals.length) throw new ConflictException(preview.refusals.join(' '));
    // The screen said one thing and the server holds another (D7).
    if (preview.expected.items !== expected.items || preview.expected.payoutLines !== expected.payoutLines) {
      throw new ConflictException('These sellers changed since the preview. Look again before merging.');
    }
    if (choices.address === 'other' && !preview.choices.address.offered) {
      throw new BadRequestException(`${preview.other.displayName} has no address to take.`);
    }
    if (choices.payout === 'other' && !preview.choices.payout.offered) {
      throw new BadRequestException(preview.choices.payout.why ?? `${preview.other.displayName}’s payout can’t be taken.`);
    }
    if (choices.businessName === 'other' && !preview.choices.businessName.other) {
      throw new BadRequestException(`${preview.other.displayName} has no business name to take.`);
    }

    const { keep, other } = await this.load(orgId, keepId, otherId);
    const keepUser = keep.membership.user;
    const otherUser = other.membership.user;
    // A check goes to an address, so taking a check payout needs one by the end.
    const finalAddress = choices.address === 'other' ? addressOf(otherUser) : addressOf(keepUser);
    if (choices.payout === 'other' && otherUser.payoutMethod === 'CHECK' && !finalAddress) {
      throw new BadRequestException('A check needs an address: take the other seller’s address too.');
    }

    const removedLineIds = preview.payoutLines.filter((l) => l.effect === 'removed').map((l) => l.lineId);
    const unapprovedLineIds = preview.payoutLines.filter((l) => l.effect === 'unapproved').map((l) => l.lineId);
    const now = new Date();

    const moved = await this.prisma.$transaction(async (tx) => {
      const itemIds = (await tx.swapItem.findMany({ where: { sellerId: other.id }, select: { id: true } })).map((i) => i.id);
      const receiptIds = (await tx.receipt.findMany({ where: { sellerId: other.id }, select: { id: true } })).map((r) => r.id);
      // A new `updatedAt` on each item is what carries the move to the iPads (D6).
      await tx.swapItem.updateMany({ where: { id: { in: itemIds } }, data: { sellerId: keep.id, updatedAt: now } });
      await tx.receipt.updateMany({ where: { id: { in: receiptIds } }, data: { sellerId: keep.id } });
      const printJobs = await tx.printJob.updateMany({ where: { sellerId: other.id }, data: { sellerId: keep.id } });
      const printers = await tx.swapPrinter.updateMany({ where: { assignedSellerId: other.id }, data: { assignedSellerId: keep.id } });

      // D4: out of their open runs, and the kept seller's approvals looked at again.
      await tx.payoutLineItem.deleteMany({ where: { lineId: { in: removedLineIds } } });
      await tx.payoutLine.deleteMany({ where: { id: { in: removedLineIds } } });
      await tx.payoutLine.updateMany({
        where: { id: { in: unapprovedLineIds }, status: 'APPROVED' },
        data: { status: 'PENDING', approvedBy: null, approvedAt: null, approvedNetCents: null },
      });

      // D3: what the kept seller takes from the other.
      const userData: Record<string, unknown> = {};
      if (choices.address === 'other') {
        Object.assign(userData, { street: otherUser.street, city: otherUser.city, state: otherUser.state, zip: otherUser.zip });
      }
      if (choices.payout === 'other') {
        Object.assign(userData, {
          payoutMethod: otherUser.payoutMethod,
          payoutTarget: otherUser.payoutTarget,
          payoutHandle: otherUser.payoutHandle,
          // The scan is the proof, and it is of the handle: it moves with it.
          payoutHandleScannedAt: otherUser.payoutHandleScannedAt,
        });
      }
      if (Object.keys(userData).length) await tx.user.update({ where: { id: keepUser.id }, data: userData });
      if (choices.businessName !== 'keep') {
        await tx.sellerProfile.update({
          where: { id: keep.id },
          data: { businessName: choices.businessName === 'other' ? other.businessName : null },
        });
      }

      await tx.sellerProfile.update({
        where: { id: other.id },
        data: { deletedAt: now, mergedIntoId: keep.id, mergedAt: now, mergedBy: actorId },
      });
      // Anything merged into the retired seller earlier now points at the kept one: one hop, always.
      await tx.sellerProfile.updateMany({ where: { mergedIntoId: other.id }, data: { mergedIntoId: keep.id } });

      await tx.auditLog.create({
        data: {
          actorType: 'user', actorId, orgId,
          action: 'ski_swap.seller.merged',
          targetType: 'seller', targetId: keep.id,
          metadata: {
            keptSellerId: keep.id, retiredSellerId: other.id,
            keptName: displayOf(keep), retiredName: displayOf(other),
            choices,
            // Enough to reverse it by hand (D8).
            itemIds, receiptIds,
            printJobs: printJobs.count, printers: printers.count,
            removedLines: preview.payoutLines.filter((l) => l.effect === 'removed'),
            unapprovedLineIds,
            keptUserBefore: choices.address === 'other' || choices.payout === 'other'
              ? pick(keepUser, ['street', 'city', 'state', 'zip', 'payoutMethod', 'payoutTarget', 'payoutHandle', 'payoutHandleScannedAt'])
              : null,
            keptBusinessNameBefore: keep.businessName,
          } as never,
        },
      });
      return { items: itemIds.length, receipts: receiptIds.length, printJobs: printJobs.count, printers: printers.count };
    });

    // The watermark the seller delta reads: the tombstone and the changed seller both go out.
    await this.touch.touch(other.membership.id);
    await this.touch.touch(keep.membership.id);

    return {
      keptSellerId: keep.id,
      retiredSellerId: other.id,
      moved,
      linesRemoved: removedLineIds.length,
      linesUnapproved: unapprovedLineIds.length,
    };
  }

  /** Both sellers, live, in this org, and two different ones. */
  private async load(orgId: string, keepId: string, otherId: string): Promise<{ keep: Seller; other: Seller }> {
    if (keepId === otherId) throw new BadRequestException('Choose two different sellers.');
    const [keep, other] = await Promise.all(
      [keepId, otherId].map((id) => this.prisma.sellerProfile.findFirst({ where: { id, membership: { orgId } }, include: SELLER })),
    );
    for (const s of [keep, other]) {
      if (!s) throw new NotFoundException('Seller not found');
      if (s.mergedIntoId) throw new ConflictException(`${displayOf(s)} was already merged into another seller.`);
      if (s.deletedAt || s.membership.deletedAt) throw new ConflictException(`${displayOf(s)} has been removed.`);
    }
    return { keep: keep!, other: other! };
  }
}

export function lineEffect(line: { status: string; frozenAt: Date | null }, isKeep: boolean, runOpen: boolean): SellerMergeLineEffect {
  if (isKeep) return runOpen && line.status === 'APPROVED' && !line.frozenAt ? 'unapproved' : 'stays';
  if (MONEY_MOVED.includes(line.status) || line.frozenAt) return PAID_NOTHING.includes(line.status) ? 'history' : 'blocks';
  if (PAID_NOTHING.includes(line.status)) return 'history';
  // PENDING or APPROVED, in a run that can still change.
  return 'removed';
}

function displayOf(s: { businessName: string | null; membership: { user: { firstName: string | null; lastName: string | null } } }): string {
  return displayName(s.membership.user, s.businessName);
}

function addressOf(u: User): string | null {
  return addressText({ street: u.street ?? '', city: u.city ?? '', state: u.state ?? '', zip: u.zip ?? '' });
}

/** How a seller is paid, in words. Null when it isn't set. */
function payoutText(u: User): string | null {
  switch (u.payoutMethod) {
    case 'VENMO': return u.payoutHandle ? `Venmo @${u.payoutHandle.replace(/^@/, '')}${u.payoutHandleScannedAt ? ' (scanned)' : ' (not scanned)'}` : 'Venmo, no handle';
    case 'PAYPAL': return u.payoutTarget === 'EMAIL' ? `PayPal: ${u.verifiedEmail ?? 'email not verified'}` : 'PayPal';
    case 'CHECK': return 'Check';
    case 'DONATE': return 'Donating to the patrol';
    default: return null;
  }
}

/** D3: a payout moves with its proof, or not at all. */
export function payoutChoice(keep: User, other: User): SellerMergePreviewResponse['choices']['payout'] {
  const base = { keep: payoutText(keep), other: payoutText(other) };
  switch (other.payoutMethod) {
    case 'CHECK':
    case 'DONATE':
      return { ...base, offered: true, why: null };
    case 'VENMO':
      return other.payoutHandle && other.payoutHandleScannedAt
        ? { ...base, offered: true, why: null }
        : { ...base, offered: false, why: 'Their Venmo handle was never scanned, so it isn’t proven.' };
    case 'PAYPAL':
      return { ...base, offered: false, why: 'A PayPal email is proven by that person’s own verified email, so it can’t move.' };
    default:
      return { ...base, offered: false, why: 'They have no payout set.' };
  }
}

function side(s: Seller, items: number): SellerMergeSide {
  const u = s.membership.user;
  return {
    sellerId: s.id,
    displayName: displayOf(s),
    businessName: s.businessName,
    email: u.email,
    emailVerified: !!u.verifiedEmail,
    phone: u.phone,
    phoneVerified: !!u.verifiedPhone,
    payout: payoutText(u),
    address: addressOf(u),
    items,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Verified contacts first, then more contact details, then the older record. */
function suggestKeep(a: Seller, b: Seller): string {
  const score = (s: Seller) => {
    const u = s.membership.user;
    return (u.verifiedEmail ? 4 : 0) + (u.verifiedPhone ? 4 : 0) + (u.email ? 1 : 0) + (u.phone ? 1 : 0) + (u.firstName || u.lastName ? 1 : 0);
  };
  const diff = score(a) - score(b);
  if (diff !== 0) return diff > 0 ? a.id : b.id;
  return a.createdAt <= b.createdAt ? a.id : b.id;
}

function sum(groups: { _count: number }[]): number {
  return groups.reduce((n, g) => n + g._count, 0);
}

function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;
}
