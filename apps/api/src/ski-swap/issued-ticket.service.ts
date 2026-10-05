import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { displayName } from '../common/util/person';
import { PosAdapterFactory } from './pos/pos.adapter';
import { isUntouched, runsOf, ticketNumberOf, type Range } from './legacy-ticket.service';
import { uncategorisedName } from './sku.util';
import { IdempotencyService } from '../common/services/idempotency.service';

/** A shop's tickets in a swap, as the Sellers page shows them (Plan 38). */
export interface IssuedTicketSummary {
  /** The numbers held, as runs: 67000–67499. */
  runs: Range[];
  issued: number;
  /** Described or priced by anyone. */
  described: number;
  /** Accepted but not yet in Square: still being put there, or stopped. */
  notInSquare: number;
  /** A push is running for this swap right now. */
  pushing: boolean;
  /** The swap can reach Square at all: a location, and Square set up. */
  squareReady: boolean;
}

export interface RemoveResult {
  removed: number;
  kept: { sku: string; why: string }[];
}

/**
 * Issuing a block of legacy tickets (Plan 38).
 *
 * Issuing creates the tickets: one item per number, unpriced, the shop as its
 * seller, accepted and on sale at once. A stub that never comes back is still
 * an item Square can ring up, at whatever price the register types.
 */
@Injectable()
export class IssuedTicketService {
  private readonly logger = new Logger(IssuedTicketService.name);
  /** Swaps with a push running, so a second request joins it rather than racing it. */
  private readonly pushing = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly posFactory: PosAdapterFactory,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Creates a ticket for every number from `start` to `end` (D1), refusing the
   * whole block if any number is already an item (D3). Answers once the items
   * exist; Square follows in the background (D9).
   */
  async issue(
    orgId: string,
    swapId: string,
    sellerId: string,
    range: { startNumber: number; endNumber: number },
    actorUserId: string,
  ): Promise<{ created: number; startNumber: number; endNumber: number }> {
    const { startNumber, endNumber } = range;
    if (startNumber > endNumber) throw new BadRequestException('The first number has to be below the last.');
    const swap = await this.swapOrThrow(orgId, swapId);
    if (!swap.allowLegacyCheckin && !swap.allowLegacyWeb) {
      throw new BadRequestException('This swap doesn’t take legacy tickets. Turn them on in its Tickets settings.');
    }
    await this.sellerOrThrow(orgId, sellerId);

    // Every live item numbered inside the block, whoever holds it.
    const live = await this.prisma.swapItem.findMany({
      where: { swapId, deletedAt: null },
      select: { sku: true, seller: { include: { membership: { include: { user: true } } } } },
    });
    const clashes = live
      .map((i) => ({ n: ticketNumberOf(i.sku), who: i.seller ? displayName(i.seller.membership.user, i.seller.businessName) : 'no seller' }))
      .filter((c): c is { n: number; who: string } => c.n !== null && c.n >= startNumber && c.n <= endNumber)
      .sort((a, b) => a.n - b.n);
    if (clashes.length) throw new BadRequestException(clashMessage(clashes));

    const numbers: string[] = [];
    for (let n = startNumber; n <= endNumber; n++) numbers.push(String(n));
    await this.addTickets(orgId, swapId, sellerId, numbers, actorUserId);
    return { created: endNumber - startNumber + 1, startNumber, endNumber };
  }

  /**
   * Batch add (Plan 40): the scanned tickets become the seller's items, any
   * seller, as issuing does. Refused whole if any is already an item, naming
   * each and whose (D11), so nothing half-lands; a retry with the same key
   * answers what the first did.
   */
  async batchAdd(
    orgId: string,
    swapId: string,
    sellerId: string,
    tickets: string[],
    actorUserId: string,
    idempotencyKey?: string,
  ): Promise<{ created: number }> {
    const scope = `batch-tickets:${orgId}:${swapId}`;
    if (idempotencyKey) {
      const cached = await this.idempotency.getCached(scope, idempotencyKey);
      if (cached) return cached as unknown as { created: number };
    }
    const swap = await this.swapOrThrow(orgId, swapId);
    if (!swap.allowLegacyCheckin && !swap.allowLegacyWeb) {
      throw new BadRequestException('This swap doesn’t take legacy tickets. Turn them on in its Tickets settings.');
    }
    await this.sellerOrThrow(orgId, sellerId);
    const numbers = tickets.map((t) => t.trim());
    if (numbers.length === 0) throw new BadRequestException('Scan at least one ticket.');
    const notTickets = numbers.filter((t) => ticketNumberOf(t) === null);
    if (notTickets.length) {
      throw new BadRequestException(`${listOf(notTickets.slice(0, 5))} ${notTickets.length === 1 ? 'isn’t a ticket number' : 'aren’t ticket numbers'}. A ticket number is digits only.`);
    }
    const repeats = [...new Set(numbers.filter((t, i) => numbers.indexOf(t) !== i))];
    if (repeats.length) throw new BadRequestException(`${listOf(repeats.slice(0, 5))} ${repeats.length === 1 ? 'is' : 'are'} in the batch twice.`);

    const taken = await this.holdersOf(swapId, numbers);
    if (taken.length) {
      throw new ConflictException({
        code: 'TICKET_TAKEN',
        message: takenMessage(taken),
        // The popover marks these rows to remove (D11).
        details: { taken },
      });
    }

    await this.addTickets(orgId, swapId, sellerId, numbers, actorUserId);
    const response = { created: numbers.length };
    if (idempotencyKey) await this.idempotency.save(scope, idempotencyKey, response);
    return response;
  }

  /**
   * Whether one scanned ticket is free in this swap (Plan 40 D9): our rows
   * only, no Square, no item payload. Run per scan, so it stays light.
   */
  async ticketCheck(orgId: string, swapId: string, sku: string): Promise<{ free: true } | { free: false; holder: string | null }> {
    if (ticketNumberOf(sku) === null) throw new BadRequestException('A ticket number is digits only.');
    await this.swapOrThrow(orgId, swapId);
    const [taken] = await this.holdersOf(swapId, [sku]);
    return taken ? { free: false, holder: taken.holder } : { free: true };
  }

  /** The live items with these SKUs, and whose each is. */
  private async holdersOf(swapId: string, skus: string[]): Promise<{ sku: string; holder: string | null }[]> {
    const rows = await this.prisma.swapItem.findMany({
      where: { swapId, deletedAt: null, sku: { in: skus } },
      select: { sku: true, seller: { include: { membership: { include: { user: true } } } } },
    });
    return rows
      .map((r) => ({ sku: r.sku, holder: r.seller ? displayName(r.seller.membership.user, r.seller.businessName) : null }))
      .sort((a, b) => Number(a.sku) - Number(b.sku));
  }

  /**
   * The tickets, created as the seller's items in one transaction (Plan 38 D1,
   * Plan 40 D10): unpriced, named by number, their tags already on the goods,
   * and accepted by whoever added them. Square follows in the background.
   */
  private async addTickets(orgId: string, swapId: string, sellerId: string, numbers: string[], actorUserId: string): Promise<void> {
    const now = new Date();
    const rows: Prisma.SwapItemCreateManyInput[] = numbers.map((sku) => ({
      id: randomUUID(),
      swapId,
      orgId,
      sellerId,
      name: uncategorisedName(sku),
      sku,
      liveSku: sku,
      priceCents: null,
      originalQuantity: 1,
      // The ticket came out of a box: there's nothing to print.
      hasPrintedTag: true,
      // Staff adding them is staff accepting them (Plan 38 D1).
      consignedAt: now,
      consignedBy: actorUserId,
      createdBy: actorUserId,
    }));
    await this.prisma.$transaction(async (tx) => {
      for (let at = 0; at < rows.length; at += 1000) {
        await tx.swapItem.createMany({ data: rows.slice(at, at + 1000) });
      }
    }, { timeout: 60_000 });
    void this.push(orgId, swapId);
  }

  /**
   * Puts the swap's accepted tickets that aren't in Square there, in batches
   * (D9). Picks up whatever is missing, so it's also the resume. One at a time
   * per swap: a second call while one runs waits for it.
   */
  push(orgId: string, swapId: string): Promise<void> {
    const running = this.pushing.get(swapId);
    if (running) return running;
    const run = this.pushPending(orgId, swapId)
      .catch((err: unknown) => this.logger.error({ err, swapId }, 'Issued ticket push stopped'))
      .finally(() => this.pushing.delete(swapId));
    this.pushing.set(swapId, run);
    return run;
  }

  private async pushPending(orgId: string, swapId: string): Promise<void> {
    const swap = await this.swapOrThrow(orgId, swapId);
    if (!swap.locationId) return;
    const pos = await this.posFactory.forOrg(orgId);
    if (!pos) return;

    let categoryId = swap.squareCategoryId;
    for (;;) {
      const pending = (await this.pendingTickets(swapId)).slice(0, 1000);
      if (pending.length === 0) return;
      const { ids, resolvedCategoryId } = await pos.syncNewItems(
        pending.map((i) => ({
          name: i.name,
          description: i.description ?? undefined,
          priceCents: i.priceCents,
          sku: i.sku,
          categoryId,
          categoryName: swap.title,
        })),
        swap.locationId,
        1,
      );
      if (resolvedCategoryId !== categoryId) {
        categoryId = resolvedCategoryId;
        await this.prisma.skiSwap.update({ where: { id: swapId }, data: { squareCategoryId: categoryId } });
      }
      const syncedAt = new Date();
      await this.prisma.$transaction(
        pending.map((item, i) => this.prisma.swapItem.update({
          where: { id: item.id },
          data: { squareItemId: ids[i].posItemId, squareVariationId: ids[i].posVariationId, lastSyncedAt: syncedAt },
        })),
      );
    }
  }

  /** Accepted ticket items not yet in Square, in number order. */
  private async pendingTickets(swapId: string) {
    const rows = await this.prisma.swapItem.findMany({
      where: { swapId, deletedAt: null, consignedAt: { not: null }, squareItemId: null },
      select: { id: true, sku: true, name: true, description: true, priceCents: true },
    });
    return rows
      .filter((r) => ticketNumberOf(r.sku) !== null)
      .sort((a, b) => ticketNumberOf(a.sku)! - ticketNumberOf(b.sku)!);
  }

  /** The whole swap's tickets and Square: how many accepted ones aren't in it, and whether it's working on them. */
  async swapPushStatus(orgId: string, swapId: string): Promise<{ notInSquare: number; pushing: boolean; squareReady: boolean }> {
    const swap = await this.swapOrThrow(orgId, swapId);
    const pending = await this.pendingTickets(swapId);
    const pos = swap.locationId ? await this.posFactory.forOrg(orgId) : null;
    return { notInSquare: pending.length, pushing: this.pushing.has(swapId), squareReady: !!pos };
  }

  /** A shop's tickets in a swap: runs, counts and where Square stands. */
  async summary(orgId: string, swapId: string, sellerId: string): Promise<IssuedTicketSummary> {
    const swap = await this.swapOrThrow(orgId, swapId);
    const rows = await this.prisma.swapItem.findMany({
      where: { swapId, sellerId, deletedAt: null },
      select: { sku: true, name: true, priceCents: true, categoryId: true, description: true, consignedAt: true, squareItemId: true },
    });
    const tickets = rows.filter((r) => ticketNumberOf(r.sku) !== null);
    const pos = swap.locationId ? await this.posFactory.forOrg(orgId) : null;
    return {
      runs: runsOf(tickets.map((t) => ticketNumberOf(t.sku)!)),
      issued: tickets.length,
      described: tickets.filter((t) => !isUntouched(t)).length,
      notInSquare: tickets.filter((t) => t.consignedAt && !t.squareItemId).length,
      pushing: this.pushing.has(swapId),
      squareReady: !!pos,
    };
  }

  /**
   * Takes back a shop's returned tickets in a span (D10): those nobody has
   * described, priced or photographed, and that haven't sold. Everything else
   * stays, with why. A ticket whose sale Square can't confirm either way stays.
   */
  async remove(
    orgId: string,
    swapId: string,
    sellerId: string,
    range: { startNumber: number; endNumber: number },
  ): Promise<RemoveResult> {
    const { startNumber, endNumber } = range;
    if (startNumber > endNumber) throw new BadRequestException('The first number has to be below the last.');
    const swap = await this.swapOrThrow(orgId, swapId);
    await this.sellerOrThrow(orgId, sellerId);

    const rows = await this.prisma.swapItem.findMany({
      where: { swapId, sellerId, deletedAt: null },
      select: {
        id: true, sku: true, name: true, priceCents: true, categoryId: true, description: true,
        squareItemId: true, squareVariationId: true, _count: { select: { photos: true } },
      },
    });
    const inSpan = rows
      .map((r) => ({ ...r, n: ticketNumberOf(r.sku) }))
      .filter((r) => r.n !== null && r.n >= startNumber && r.n <= endNumber)
      .sort((a, b) => a.n! - b.n!);

    const kept: RemoveResult['kept'] = [];
    const candidates = inSpan.filter((t) => {
      if (t.priceCents !== null) kept.push({ sku: t.sku, why: 'priced' });
      else if (!isUntouched(t)) kept.push({ sku: t.sku, why: 'described' });
      else if (t._count.photos > 0) kept.push({ sku: t.sku, why: 'has photos' });
      else return true;
      return false;
    });

    // Sold is Square's to say. Its count is "in stock" only while one is left.
    const inSquare = candidates.filter((t) => t.squareVariationId);
    let stock: Map<string, number> | null = new Map();
    if (inSquare.length) {
      const pos = swap.locationId ? await this.posFactory.forOrg(orgId) : null;
      stock = pos
        ? await pos.getInventoryCounts(inSquare.map((t) => t.squareVariationId!), swap.locationId).catch(() => null)
        : null;
    }
    const removable = candidates.filter((t) => {
      if (!t.squareVariationId) return true;
      if (stock === null) {
        kept.push({ sku: t.sku, why: 'Square couldn’t say whether it sold' });
        return false;
      }
      if ((stock.get(t.squareVariationId) ?? 0) < 1) {
        kept.push({ sku: t.sku, why: 'sold' });
        return false;
      }
      return true;
    });

    if (removable.length) {
      await this.prisma.swapItem.updateMany({
        where: { id: { in: removable.map((t) => t.id) }, deletedAt: null },
        data: { deletedAt: new Date(), liveSku: null },
      });
      const squareIds = removable.map((t) => t.squareItemId).filter((id): id is string => !!id);
      if (squareIds.length) {
        const pos = await this.posFactory.forOrg(orgId);
        await pos?.deleteItems(squareIds).catch((err: unknown) =>
          this.logger.error({ err, swapId }, 'Could not take returned tickets out of Square'));
      }
    }

    kept.sort((a, b) => Number(a.sku) - Number(b.sku));
    return { removed: removable.length, kept };
  }

  private async swapOrThrow(orgId: string, swapId: string) {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId } });
    if (!swap) throw new NotFoundException('Swap not found');
    return swap;
  }

  private async sellerOrThrow(orgId: string, sellerId: string) {
    const seller = await this.prisma.sellerProfile.findFirst({
      where: { id: sellerId, deletedAt: null, membership: { orgId } },
    });
    if (!seller) throw new NotFoundException('Seller not found');
    return seller;
  }

}

/**
 * "67012 and 67013 are already items (Stowe Sports)." Grouped by holder, the
 * first dozen numbers shown, the rest counted.
 */
export function clashMessage(clashes: { n: number; who: string }[]): string {
  const shown = clashes.slice(0, 12);
  const byWho = new Map<string, number[]>();
  for (const c of shown) byWho.set(c.who, [...(byWho.get(c.who) ?? []), c.n]);
  const parts = [...byWho].map(([who, ns]) => `${listOf(ns.map(String))} (${who})`);
  const more = clashes.length - shown.length;
  const verb = clashes.length === 1 ? 'is already an item' : 'are already items';
  return `${parts.join('; ')}${more > 0 ? ` and ${more} more` : ''} ${verb}. Nothing was issued.`;
}

/**
 * "Ticket 67169 belongs to Stowe Sports." for one; for several, grouped by
 * holder as `clashMessage` does: "67169 and 67170 (Stowe Sports) and 67200
 * (Dana Reyes) are already taken. Nothing was added."
 */
export function takenMessage(taken: { sku: string; holder: string | null }[]): string {
  if (taken.length === 1) {
    const [t] = taken;
    return t.holder ? `Ticket ${t.sku} belongs to ${t.holder}.` : `Ticket ${t.sku} is already on another item.`;
  }
  const shown = taken.slice(0, 12);
  const byWho = new Map<string, string[]>();
  for (const t of shown) {
    const who = t.holder ?? 'no seller';
    byWho.set(who, [...(byWho.get(who) ?? []), t.sku]);
  }
  const parts = [...byWho].map(([who, skus]) => `${listOf(skus)} (${who})`);
  const more = taken.length - shown.length;
  return `${listOf(parts)}${more > 0 ? ` and ${more} more` : ''} are already taken. Nothing was added.`;
}

function listOf(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
