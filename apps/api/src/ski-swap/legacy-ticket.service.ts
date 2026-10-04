import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { parse as parseCsv } from 'csv-parse/sync';
import { displayName } from '../common/util/person';
import type { LegacyTicketRangeResponse, TicketSeller } from '../contracts/ski-swap.contracts';

/** A bare ticket number: digits and nothing else. */
const TICKET_NUMBER = /^\d+$/;

export type Range = { startNumber: number; endNumber: number };

/**
 * One row's fate. `ok` means it passed the check but nothing was written yet.
 * `generated` marks a row with no ticket that gets a new SKU (Plan 31); once
 * created, `sku` is that SKU.
 */
export type ImportRowResult = {
  line: number;
  sku: string;
  outcome: 'ok' | 'created' | 'error';
  error?: string;
  generated?: boolean;
};

/** How an upload treats rows without a ticket (Plan 31). */
export interface ImportRules {
  /** The uploader asked for SKUs to be generated for rows without a ticket. */
  generateSkus: boolean;
  /** The swap's web takes legacy tickets only, so nothing may be generated. */
  webTicketsOnly: boolean;
  /** The swap takes legacy tickets at all. Off, only generated rows can be imported. Default on. */
  acceptsTickets?: boolean;
}

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

  /**
   * Everyone in this swap who holds tickets, with how much of them is spent.
   *
   * What the staff import picker offers. Ordered by name because it is read as
   * a list of shops rather than of ranges.
   */
  /**
   * Who an upload can be for: everyone holding tickets in this swap when its
   * web takes legacy tickets, and every business seller when its web takes
   * print tickets (Plan 34). Rows without a ticket get generated SKUs.
   */
  async sellersWithRanges(orgId: string, swapId: string): Promise<TicketSeller[]> {
    const [rows, swap] = await Promise.all([
      this.prisma.legacyTicketRange.findMany({
        where: { orgId, swapId, seller: { deletedAt: null } },
        orderBy: { startNumber: 'asc' },
        include: { seller: { include: { membership: { include: { user: true } } } } },
      }),
      this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { allowLegacyWeb: true, allowPrintWeb: true } }),
    ]);

    // Ranges count only where the web takes legacy tickets.
    const ranges = swap?.allowLegacyWeb ? rows : [];
    const used = ranges.length ? await this.usedNumbers(swapId) : new Set<number>();
    const bySeller = new Map<string, TicketSeller>();

    if (swap?.allowPrintWeb) {
      const shops = await this.prisma.sellerProfile.findMany({
        where: { deletedAt: null, businessName: { not: null }, membership: { orgId, deletedAt: null } },
        include: { membership: { include: { user: true } } },
      });
      for (const shop of shops) {
        bySeller.set(shop.id, {
          sellerId: shop.id,
          displayName: displayName(shop.membership.user, shop.businessName),
          ranges: [],
          ticketCount: 0,
          usedCount: 0,
        });
      }
    }

    for (const r of ranges) {
      const entry = bySeller.get(r.sellerId) ?? {
        sellerId: r.sellerId,
        displayName: displayName(r.seller.membership.user, r.seller.businessName),
        ranges: [],
        ticketCount: 0,
        usedCount: 0,
      };
      entry.ranges.push({ startNumber: r.startNumber, endNumber: r.endNumber });
      entry.ticketCount += r.endNumber - r.startNumber + 1;
      for (let n = r.startNumber; n <= r.endNumber; n++) if (used.has(n)) entry.usedCount++;
      bySeller.set(r.sellerId, entry);
    }

    return [...bySeller.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
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
   * unique index on (swapId, liveSku) would catch two shops holding one number
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
  /**
   * Which business seller, if any, was issued this number for this swap.
   *
   * One stockpile is spent two ways — a block handed to a shop, or a loose
   * ticket given to somebody at the counter — so a number an individual scans
   * has to be checked against what is already spoken for. Null means nobody
   * holds it, which is the ordinary answer for a loose one.
   */
  async holderOf(swapId: string, sku: string): Promise<{ sellerId: string; name: string } | null> {
    const n = ticketNumberOf(sku);
    if (n === null) return null;

    const row = await this.prisma.legacyTicketRange.findFirst({
      where: { swapId, startNumber: { lte: n }, endNumber: { gte: n } },
      select: {
        sellerId: true,
        seller: { include: { membership: { include: { user: true } } } },
      },
    });
    if (!row) return null;

    return {
      sellerId: row.sellerId,
      name: displayName(row.seller.membership.user, row.seller.businessName),
    };
  }

  async usedNumbers(swapId: string): Promise<Set<number>> {
    const items = await this.prisma.swapItem.findMany({
      // A withdrawn item's ticket goes back in the pile, which is what happens
      // physically. Counting a tombstone here would tell the counter a number
      // is spent on an item that was deleted an hour ago.
      where: { swapId, deletedAt: null },
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
  ): Promise<{ ranges: Range[]; suggested: number | null; exhausted: boolean; webTicketsOnly: boolean }> {
    const [ranges, used, swap] = await Promise.all([
      this.listForSeller(swapId, sellerId),
      this.usedNumbers(swapId),
      this.prisma.skiSwap.findUnique({ where: { id: swapId }, select: { allowLegacyWeb: true, allowPrintWeb: true } }),
    ]);
    // A swap whose web takes no legacy tickets offers none on the web, whatever
    // blocks a seller holds (Plan 34): they're for staff check-in there.
    const offered = swap?.allowLegacyWeb ? ranges : [];
    return {
      ranges: offered,
      suggested: suggestNext(offered, used),
      exhausted: offered.length > 0 && !hasAnyUnused(offered, used),
      // The web takes legacy tickets only: no print tickets there.
      webTicketsOnly: swap ? !swap.allowPrintWeb : false,
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
      where: { swapId, sku, deletedAt: null },
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

  // ─── CSV import ────────────────────────────────────────────────────────────

  /**
   * Reads the three columns out of a file, whatever they are called.
   *
   * `sku` is required. `price` may be blank, or the column absent, for ticket
   * rows, whose price can come later (Plan 32); `checkImportRows` asks for one
   * on any row that gets a generated SKU. `name` is optional and may be absent
   * from the file entirely. Aliases follow the seller import's approach so that
   * `price`, `Price`, `amount` and `cost` all land on the same field.
   */
  parseItemCsv(
    buffer: Buffer,
  ): { rows: { sku: string; name?: string; description?: string; priceCents: number | null }[] } {
    /**
     * Strict about column counts on purpose, but not about how it says so.
     *
     * A description with a comma in it — "170cm, edges good" — is three fields
     * unless the file quotes it, which spreadsheets do and hand-typed files do
     * not. The parser's own complaint is "Invalid Record Length: expect 3, got
     * 4 on line 7", which reached staff as a 500. Relaxing the count instead
     * would silently file the tail of a description as a price.
     */
    let records: string[][];
    try {
      records = parseCsv(buffer, { skip_empty_lines: true, trim: true });
    } catch (err) {
      const line = /on line (\d+)/.exec(err instanceof Error ? err.message : '')?.[1];
      throw new BadRequestException(
        `Line ${line ?? '?'} has more columns than the header. ` +
          'A name or description containing a comma has to be in quotes: "170cm, edges good".',
      );
    }
    if (!records.length) return { rows: [] };

    const [rawHeaders, ...dataRows] = records;
    const headers = rawHeaders.map((h) => h.trim().toLowerCase());
    const indexOf = (aliases: string[]) => headers.findIndex((h) => aliases.includes(h));

    const skuAt = indexOf(['sku', 'ticket', 'ticket number', 'number', 'tag']);
    const nameAt = indexOf(['name', 'item', 'title']);
    // Its own column, not a name any more. Square shows a description to
    // buyers, and a shop writing "177cm, small topsheet scratch" means it as
    // the detail under the title rather than as the title.
    const descAt = indexOf(['description', 'details', 'notes']);
    const priceAt = indexOf(['price', 'amount', 'cost', 'value']);

    // No ticket column is a file of rows without tickets: fine when SKUs are
    // generated, and each row says so when they aren't (`checkImportRows`).
    // No price column is a file of unpriced tickets, judged the same way.

    const rows = dataRows.map((row) => ({
      sku: skuAt === -1 ? '' : (row[skuAt] ?? '').trim(),
      name: nameAt === -1 ? undefined : (row[nameAt] ?? '').trim() || undefined,
      description: descAt === -1 ? undefined : (row[descAt] ?? '').trim() || undefined,
      // "$250.00" and "250" both mean the same thing to whoever typed it. A
      // blank cell is no price; anything else that isn't an amount is NaN, and
      // refused as one.
      priceCents: priceOf(priceAt === -1 ? '' : (row[priceAt] ?? '')),
    }));
    return { rows };
  }

  /**
   * Checks a whole file and says whether it may be written.
   *
   * Every row is judged before any of them lands: a half-imported inventory is
   * worse than a rejected one, because the seller cannot tell which half. A
   * result carrying any `error` means nothing should be written at all.
   *
   * Rows may skip numbers and go backwards. The high-water mark decides what
   * the *form* suggests and has no say here — a shop entering a pad they
   * worked through out of order is exactly the file this exists to accept.
   *
   * Checking and writing are deliberately separate. The write has to go through
   * `ItemService.create`, which is what knows about consignment and Square, and
   * that service already depends on this one — so the rules stay here and the
   * writing happens on the side that can reach both.
   */
  /**
   * Checks an upload before anything is written (Plan 31).
   *
   * A row with a ticket must be one of this seller's, unused, once. A row
   * without one gets a generated SKU when `generateSkus` is on, and is an
   * error otherwise. Generating is refused outright for a swap whose web takes
   * legacy tickets only.
   */
  async checkImportRows(
    swapId: string,
    sellerId: string,
    rows: { sku: string; name?: string; description?: string; priceCents: number | null }[],
    rules: ImportRules,
  ): Promise<ImportRowResult[]> {
    if (rules.generateSkus && rules.webTicketsOnly) {
      throw new BadRequestException(
        'This swap takes legacy tickets only on the web, so SKUs can’t be generated.',
      );
    }
    const ranges = await this.listForSeller(swapId, sellerId);
    if (ranges.length === 0 && !rules.generateSkus) {
      throw new BadRequestException(
        rules.webTicketsOnly
          ? 'This seller has no ticket ranges for this swap, and it takes legacy tickets only on the web.'
          : 'This seller has no ticket ranges for this swap. Turn on “Generate SKUs as needed” to give each row a new SKU.',
      );
    }
    const used = await this.usedNumbers(swapId);

    const results: ImportRowResult[] = [];
    const seen = new Map<string, number>();

    rows.forEach((row, i) => {
      const line = i + 2;
      const sku = row.sku?.trim() ?? '';
      const fail = (error: string) => results.push({ line, sku, outcome: 'error', error });

      // A ticket may wait for its price (Plan 32); a price that's there has
      // to be one.
      if (row.priceCents !== null && (!Number.isFinite(row.priceCents) || row.priceCents <= 0)) {
        return fail('A price has to be an amount above $0.');
      }
      if (!sku) {
        if (rules.generateSkus) {
          if (row.priceCents === null) return fail('A row without a ticket needs a price.');
          return results.push({ line, sku, outcome: 'ok', generated: true });
        }
        return fail(
          rules.webTicketsOnly
            ? 'Every row needs a ticket number.'
            : 'Every row needs a ticket number, or turn on “Generate SKUs as needed”.',
        );
      }
      if (rules.acceptsTickets === false) return fail('This swap doesn’t take legacy tickets.');
      const n = ticketNumberOf(sku);
      if (n === null) return fail('A ticket number is just the digits on the ticket.');
      if (ranges.length === 0) {
        return fail('This seller has no tickets for this swap. Leave the ticket blank to generate a SKU.');
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

/** A price cell as cents: null when blank, NaN when it isn't an amount. */
function priceOf(cell: string): number | null {
  const digits = cell.replace(/[^0-9.]/g, '');
  if (cell.trim() === '') return null;
  return digits ? Math.round(parseFloat(digits) * 100) : NaN;
}
