import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { parse as parseCsv } from 'csv-parse/sync';
import { displayName } from '../common/util/person';
import type { LegacyTicketRangeResponse } from '../contracts/ski-swap.contracts';

/** A bare ticket number: digits and nothing else. */
const TICKET_NUMBER = /^\d+$/;

export type Range = { startNumber: number; endNumber: number };

/** One row's fate. `ok` means it passed the check but nothing was written yet. */
export type ImportRowResult = {
  line: number;
  sku: string;
  outcome: 'ok' | 'created' | 'error';
  error?: string;
};

/** Parses a SKU as a ticket number, or null if it is one of ours. */
export function ticketNumberOf(sku: string): number | null {
  return TICKET_NUMBER.test(sku) ? Number(sku) : null;
}

export function inAnyRange(n: number, ranges: Range[]): boolean {
  return ranges.some((r) => n >= r.startNumber && n <= r.endNumber);
}

/** Every number a set of ranges covers, ascending, deduplicated across overlaps. */
export function countOf(ranges: Range[]): number {
  return ranges.reduce((sum, r) => sum + (r.endNumber - r.startNumber + 1), 0);
}

/**
 * The number to offer next, or null when there is nothing above the mark.
 *
 * The suggestion carries on past gaps — the first number above the highest
 * used — because a skipped ticket is usually gone, and offering it back on
 * every item would make the default something to correct rather than accept.
 * It suggests only; what may be *entered* is decided by `assertUsable`, which
 * never consults the mark (D7).
 */
export function suggestNext(ranges: Range[], used: Set<number>): number | null {
  if (ranges.length === 0) return null;
  const sorted = [...ranges].sort((a, b) => a.startNumber - b.startNumber);

  const inRange = [...used].filter((n) => inAnyRange(n, sorted));
  const high = inRange.length ? Math.max(...inRange) : null;

  for (const r of sorted) {
    // Rolling into the next range matters: a seller whose highest used is the
    // top of one block should be offered the bottom of the next, not nothing.
    const from = high === null ? r.startNumber : Math.max(r.startNumber, high + 1);
    for (let n = from; n <= r.endNumber; n++) {
      if (!used.has(n)) return n;
    }
  }
  return null;
}

/** Whether any number at all remains unused — which is what "out" means (D6). */
export function hasAnyUnused(ranges: Range[], used: Set<number>): boolean {
  return ranges.some((r) => {
    for (let n = r.startNumber; n <= r.endNumber; n++) if (!used.has(n)) return true;
    return false;
  });
}

function describe(ranges: Range[]): string {
  return ranges.map((r) => `${r.startNumber}–${r.endNumber}`).join(', ');
}

/**
 * Ticket blocks the organisation issued to a business seller, and the rules for
 * spending them.
 *
 * A ticket is nothing to us until it lands on an item, so the items are the
 * record of what has been used (D5) — there is no consumption table to drift
 * from them. Everything here derives from `SwapItem.sku`.
 */
@Injectable()
export class LegacyTicketService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Ranges ────────────────────────────────────────────────────────────────

  async listForSeller(swapId: string, sellerId: string): Promise<Range[]> {
    return this.prisma.legacyTicketRange.findMany({
      where: { swapId, sellerId },
      orderBy: { startNumber: 'asc' },
      select: { startNumber: true, endNumber: true },
    });
  }

  /** What the Sellers page shows: the blocks, and how much of each is spent. */
  async listForSellerWithUse(
    orgId: string,
    swapId: string,
    sellerId: string,
  ): Promise<LegacyTicketRangeResponse[]> {
    const rows = await this.prisma.legacyTicketRange.findMany({
      where: { orgId, swapId, sellerId },
      orderBy: { startNumber: 'asc' },
    });
    const used = await this.usedNumbers(swapId);

    return rows.map((r) => {
      let usedHere = 0;
      for (let n = r.startNumber; n <= r.endNumber; n++) if (used.has(n)) usedHere++;
      return {
        id: r.id,
        swapId: r.swapId,
        sellerId: r.sellerId,
        startNumber: r.startNumber,
        endNumber: r.endNumber,
        ticketCount: r.endNumber - r.startNumber + 1,
        usedCount: usedHere,
      };
    });
  }

  /**
   * Issues a block to a seller.
   *
   * Overlap is checked across every seller in the swap, not just this one. The
   * unique index on (swapId, sku) would catch two shops holding one number
   * eventually — but only when the second saves an item, mid-swap, at a counter.
   */
  async addRange(
    orgId: string,
    swapId: string,
    sellerId: string,
    data: { startNumber: number; endNumber: number },
    actorUserId?: string,
  ): Promise<LegacyTicketRangeResponse[]> {
    if (data.startNumber > data.endNumber) {
      throw new BadRequestException('The first number has to be below the last.');
    }
    await this.assertSellerInSwap(orgId, swapId, sellerId);
    await this.assertNoPrinter(orgId, sellerId);

    const clash = await this.prisma.legacyTicketRange.findFirst({
      where: {
        swapId,
        startNumber: { lte: data.endNumber },
        endNumber: { gte: data.startNumber },
      },
      include: { seller: { include: { membership: { include: { user: true } } } } },
    });
    if (clash) {
      const who = displayName(clash.seller.membership.user, clash.seller.businessName);
      // No possessive: a shop called "Alpine Sports" would read as
      // "Alpine Sports's", and the name is the seller's to spell, not ours.
      throw new ConflictException(
        `${data.startNumber}–${data.endNumber} overlaps ${clash.startNumber}–` +
          `${clash.endNumber}, held by ${who}.`,
      );
    }

    await this.prisma.legacyTicketRange.create({
      data: {
        id: createId(),
        orgId,
        swapId,
        sellerId,
        startNumber: data.startNumber,
        endNumber: data.endNumber,
        createdBy: actorUserId ?? null,
        updatedAt: new Date(),
      },
    });
    return this.listForSellerWithUse(orgId, swapId, sellerId);
  }

  /**
   * Takes a block back.
   *
   * Refused while any of its numbers is on an item: those tickets are on the
   * goods, and removing the range would leave items nobody can account for.
   */
  async removeRange(orgId: string, rangeId: string): Promise<LegacyTicketRangeResponse[]> {
    const range = await this.prisma.legacyTicketRange.findFirst({ where: { id: rangeId, orgId } });
    if (!range) throw new NotFoundException('Ticket range not found');

    const used = await this.usedNumbers(range.swapId);
    const inUse: number[] = [];
    for (let n = range.startNumber; n <= range.endNumber; n++) {
      if (used.has(n)) inUse.push(n);
    }
    if (inUse.length) {
      const shown = inUse.slice(0, 5).join(', ');
      throw new ConflictException(
        `${inUse.length} ticket${inUse.length === 1 ? '' : 's'} in this range ` +
          `${inUse.length === 1 ? 'is' : 'are'} already on items (${shown}` +
          `${inUse.length > 5 ? ', …' : ''}). Remove those items first.`,
      );
    }

    await this.prisma.legacyTicketRange.delete({ where: { id: rangeId } });
    return this.listForSellerWithUse(orgId, range.swapId, range.sellerId);
  }

  // ─── Spending a number ─────────────────────────────────────────────────────

  /** Every ticket number already on an item in this swap. */
  async usedNumbers(swapId: string): Promise<Set<number>> {
    const items = await this.prisma.swapItem.findMany({
      where: { swapId },
      select: { sku: true },
    });
    const used = new Set<number>();
    for (const i of items) {
      const n = ticketNumberOf(i.sku);
      if (n !== null) used.add(n);
    }
    return used;
  }

  /** Whether this seller is on tickets rather than a printer. */
  async isLegacySeller(swapId: string, sellerId: string): Promise<boolean> {
    const count = await this.prisma.legacyTicketRange.count({ where: { swapId, sellerId } });
    return count > 0;
  }

  /**
   * What the item form needs: the number to offer, and whether anything is left.
   *
   * The two are separate answers. Past the top of their ranges a seller has no
   * suggestion but may still enter a skipped ticket they have found (D7); only
   * when nothing at all is unused are they actually out (D6).
   */
  async formState(
    swapId: string,
    sellerId: string,
  ): Promise<{ ranges: Range[]; suggested: number | null; exhausted: boolean }> {
    const ranges = await this.listForSeller(swapId, sellerId);
    const used = await this.usedNumbers(swapId);
    return {
      ranges,
      suggested: suggestNext(ranges, used),
      exhausted: ranges.length > 0 && !hasAnyUnused(ranges, used),
    };
  }

  /**
   * Refuses a number the seller may not use.
   *
   * Two tests and no others: it is inside one of their ranges, and no item is
   * using it. The high-water mark is deliberately not consulted — that is what
   * lets a ticket found after the seller worked past it still be entered.
   */
  async assertUsable(swapId: string, sellerId: string, sku: string): Promise<void> {
    const n = ticketNumberOf(sku);
    if (n === null) {
      throw new BadRequestException('A ticket number is just the digits on the ticket.');
    }

    const ranges = await this.listForSeller(swapId, sellerId);
    if (ranges.length === 0) {
      throw new BadRequestException('This seller has no ticket ranges for this swap.');
    }
    if (!inAnyRange(n, ranges)) {
      throw new BadRequestException(
        `${n} is not one of your tickets. Yours are ${describe(ranges)}.`,
      );
    }

    const taken = await this.prisma.swapItem.findFirst({
      where: { swapId, sku },
      select: { id: true },
    });
    if (taken) throw new ConflictException(`Ticket ${n} is already on another item.`);
  }

  /** The message a seller sees when every number they hold is spent (D6). */
  async assertNotExhausted(swapId: string, sellerId: string): Promise<void> {
    const { ranges, exhausted } = await this.formState(swapId, sellerId);
    if (exhausted) {
      throw new ConflictException(
        `All of your tickets (${describe(ranges)}) are on items. ` +
          'Ask staff for another range.',
      );
    }
  }

  // ─── Exclusivity with printers (D1) ────────────────────────────────────────

  /** Refuses a range for a seller who already prints their own tags. */
  async assertNoPrinter(orgId: string, sellerId: string): Promise<void> {
    const printer = await this.prisma.swapPrinter.findFirst({
      where: { orgId, assignedSellerId: sellerId },
      select: { name: true },
    });
    if (printer) {
      throw new ConflictException(
        `This seller has a printer (${printer.name}). Unassign it first.`,
      );
    }
  }

  /** Refuses a printer for a seller who is on issued tickets. */
  async assertNoRanges(orgId: string, sellerId: string): Promise<void> {
    const range = await this.prisma.legacyTicketRange.findFirst({
      where: { orgId, sellerId },
      select: { id: true },
    });
    if (range) {
      throw new ConflictException(
        'This seller uses issued tickets. Remove their ranges first.',
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * The name an item gets when the seller did not give one (D12).
   *
   * Built from `displayName`, which falls through business name to person to
   * contact, so the result is never blank — `SwapItem.name` is non-null and
   * Square requires a name.
   */
  async fallbackName(sellerId: string, sku: string): Promise<string> {
    const seller = await this.prisma.sellerProfile.findUnique({
      where: { id: sellerId },
      include: { membership: { include: { user: true } } },
    });
    if (!seller) return sku;
    return `${displayName(seller.membership.user, seller.businessName)} ${sku}`;
  }

  // ─── CSV import ────────────────────────────────────────────────────────────

  /**
   * Reads the three columns out of a file, whatever they are called.
   *
   * `sku` and `price` are required; `name` is optional and may be absent from
   * the file entirely. Aliases follow the seller import's approach so that
   * `price`, `Price`, `amount` and `cost` all land on the same field.
   */
  parseItemCsv(buffer: Buffer): { rows: { sku: string; name?: string; priceCents: number }[] } {
    const records: string[][] = parseCsv(buffer, { skip_empty_lines: true, trim: true });
    if (!records.length) return { rows: [] };

    const [rawHeaders, ...dataRows] = records;
    const headers = rawHeaders.map((h) => h.trim().toLowerCase());
    const indexOf = (aliases: string[]) => headers.findIndex((h) => aliases.includes(h));

    const skuAt = indexOf(['sku', 'ticket', 'ticket number', 'number', 'tag']);
    const nameAt = indexOf(['name', 'item', 'description', 'title']);
    const priceAt = indexOf(['price', 'amount', 'cost', 'value']);

    if (skuAt === -1) throw new BadRequestException('The file needs a "sku" column.');
    if (priceAt === -1) throw new BadRequestException('The file needs a "price" column.');

    const rows = dataRows.map((row) => ({
      sku: (row[skuAt] ?? '').trim(),
      name: nameAt === -1 ? undefined : (row[nameAt] ?? '').trim() || undefined,
      // "$250.00" and "250" both mean the same thing to whoever typed it.
      priceCents: Math.round(parseFloat((row[priceAt] ?? '').replace(/[^0-9.]/g, '')) * 100),
    }));
    return { rows };
  }

  /**
   * Checks a whole file, then writes it, or writes nothing.
   *
   * Nothing lands until every row has passed: a half-imported inventory is
   * worse than a rejected one, because the seller cannot tell which half.
   *
   * Rows may skip numbers and go backwards. The high-water mark decides what
   * the *form* suggests and has no say here — a shop entering a pad they
   * worked through out of order is exactly the file this exists to accept.
   */
  async importItems(
    orgId: string,
    swapId: string,
    sellerId: string,
    rows: { sku: string; name?: string; priceCents: number }[],
  ): Promise<ImportRowResult[]> {
    const ranges = await this.listForSeller(swapId, sellerId);
    if (ranges.length === 0) {
      throw new BadRequestException('This seller has no ticket ranges for this swap.');
    }
    const used = await this.usedNumbers(swapId);

    const results: ImportRowResult[] = [];
    const seen = new Map<string, number>();

    rows.forEach((row, i) => {
      const line = i + 2;
      const sku = row.sku?.trim() ?? '';
      const fail = (error: string) => results.push({ line, sku, outcome: 'error', error });

      if (!sku) return fail('Every row needs a ticket number.');
      const n = ticketNumberOf(sku);
      if (n === null) return fail('A ticket number is just the digits on the ticket.');
      if (!Number.isFinite(row.priceCents) || row.priceCents <= 0) {
        return fail('Every row needs a price.');
      }
      if (!inAnyRange(n, ranges)) {
        return fail(`${n} is not one of this seller's tickets. Theirs are ${describe(ranges)}.`);
      }
      if (used.has(n)) return fail(`Ticket ${n} is already on another item.`);

      const earlier = seen.get(sku);
      if (earlier !== undefined) return fail(`Ticket ${n} is also on line ${earlier}.`);
      seen.set(sku, line);

      results.push({ line, sku, outcome: 'ok' });
    });

    if (results.some((r) => r.outcome === 'error')) return results;

    // Every row passed, so the writes can go ahead.
    const fallback = await this.fallbackName(sellerId, '');
    for (let i = 0; i < rows.length; i++) {
      const sku = rows[i].sku.trim();
      const name = rows[i].name?.trim() || `${fallback.trim()} ${sku}`;
      await this.prisma.swapItem.create({
        data: {
          id: createId(),
          swapId,
          orgId,
          sellerId,
          name,
          priceCents: rows[i].priceCents,
          sku,
          originalQuantity: 1,
          // The ticket is already on the goods (D8).
          hasPrintedTag: true,
        },
      });
      results[i] = { ...results[i], outcome: 'created' };
    }
    return results;
  }

  private async assertSellerInSwap(orgId: string, swapId: string, sellerId: string) {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId } });
    if (!swap) throw new NotFoundException('Swap not found');
    const seller = await this.prisma.sellerProfile.findFirst({
      where: { id: sellerId, deletedAt: null, membership: { orgId } },
    });
    if (!seller) throw new NotFoundException('Seller not found');
  }
}
