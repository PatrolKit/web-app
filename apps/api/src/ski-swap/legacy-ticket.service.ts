import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parse as parseCsv } from 'csv-parse/sync';
import { displayName } from '../common/util/person';
import type { TicketSeller } from '../contracts/ski-swap.contracts';
import { uncategorisedName } from './sku.util';
import { BASE_COLUMNS, type ImportUnknown } from './import-details';

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
  outcome: 'ok' | 'created' | 'updated' | 'error';
  error?: string;
  generated?: boolean;
  /** The issued ticket a ticket row fills in (Plan 38). */
  itemId?: string;
  /** The category the row matched (Plan 42). */
  categoryId?: string;
  /** Cells that matched nothing, and so aren't stored (Plan 42). */
  unknown?: ImportUnknown[];
};

/** One row of an imported file, as parsed. */
export interface ImportFileRow {
  sku: string;
  name?: string;
  description?: string;
  priceCents: number | null;
  /** Every cell, for the category and detail columns (Plan 42). Absent from callers that build rows by hand. */
  cells?: string[];
}

/** What an upload answers: each row, and whether the file was written (Plan 42). */
export interface ImportResult {
  rows: ImportRowResult[];
  /** Columns that are neither ours nor any category's detail. */
  ignoredColumns: string[];
  /** Why nothing was written: a row error, or unknowns without `acceptUnknown`. Null once written. */
  refused: 'errors' | 'unknown' | null;
}

/** How an upload treats rows without a ticket (Plan 31). */
export interface ImportRules {
  /** The uploader asked for SKUs to be generated for rows without a ticket. */
  generateSkus: boolean;
  /** The swap's web takes legacy tickets only, so nothing may be generated. */
  webTicketsOnly: boolean;
  /** The swap takes legacy tickets at all. Off, only generated rows can be imported. Default on. */
  acceptsTickets?: boolean;
  /** The shop's own file, held to "once only" (Plan 38 D6); staff aren't. */
  shopOwn?: boolean;
}

/** Parses a SKU as a ticket number, or null if it is one of ours. */
export function ticketNumberOf(sku: string): number | null {
  return TICKET_NUMBER.test(sku) ? Number(sku) : null;
}

function describe(ranges: Range[]): string {
  return ranges.map((r) => (r.startNumber === r.endNumber ? `${r.startNumber}` : `${r.startNumber}–${r.endNumber}`)).join(', ');
}

/** Ticket numbers as runs of consecutive numbers: [1,2,3,7] is 1–3 and 7. */
export function runsOf(numbers: number[]): Range[] {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs: Range[] = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && n === last.endNumber + 1) last.endNumber = n;
    else runs.push({ startNumber: n, endNumber: n });
  }
  return runs;
}

/** What an item needs for "untouched": the fields a description or price sets. */
export type TicketFields = {
  sku: string;
  name: string;
  priceCents: number | null;
  categoryId: string | null;
  description: string | null;
};

/**
 * A ticket nobody has described or priced (Plan 38 D6): still its stand-in
 * name, with no price, no type and no notes. An issued ticket starts so, and a
 * shop may fill it in once.
 */
export function isUntouched(item: TicketFields): boolean {
  return item.priceCents === null && item.categoryId === null && !item.description && item.name === uncategorisedName(item.sku);
}

/** One of a seller's tickets, as the rules below read it. */
export type HeldTicket = TicketFields & { id: string; number: number };

/**
 * Legacy tickets as items (Plan 38).
 *
 * Issuing a block creates its tickets (`IssuedTicketService`), so the items
 * are the whole record: who holds a ticket is its item's seller, and nothing
 * else keeps ranges. Everything here derives from `SwapItem`.
 */
@Injectable()
export class LegacyTicketService {
  constructor(private readonly prisma: PrismaService) {}

  /** A seller's live tickets in a swap, in number order. */
  async heldBy(swapId: string, sellerId: string): Promise<HeldTicket[]> {
    const rows = await this.prisma.swapItem.findMany({
      where: { swapId, sellerId, deletedAt: null },
      select: { id: true, sku: true, name: true, priceCents: true, categoryId: true, description: true },
    });
    return rows
      .map((r) => ({ ...r, number: ticketNumberOf(r.sku) }))
      .filter((r): r is HeldTicket => r.number !== null)
      .sort((a, b) => a.number - b.number);
  }

  /**
   * Who an upload can be for: everyone holding tickets in this swap when its
   * web takes legacy tickets, and every business seller when its web takes
   * print tickets (Plan 34). Rows without a ticket get generated SKUs.
   */
  async sellersWithTickets(orgId: string, swapId: string): Promise<TicketSeller[]> {
    const swap = await this.prisma.skiSwap.findFirst({
      where: { id: swapId, orgId },
      select: { allowLegacyWeb: true, allowPrintWeb: true },
    });
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

    // Tickets count only where the web takes them.
    if (swap?.allowLegacyWeb) {
      const items = await this.prisma.swapItem.findMany({
        where: { swapId, deletedAt: null, sellerId: { not: null }, seller: { deletedAt: null } },
        select: {
          sku: true, name: true, priceCents: true, categoryId: true, description: true, sellerId: true,
          seller: { include: { membership: { include: { user: true } } } },
        },
      });
      const numbers = new Map<string, number[]>();
      for (const item of items) {
        const n = ticketNumberOf(item.sku);
        if (n === null || !item.sellerId || !item.seller) continue;
        const entry = bySeller.get(item.sellerId) ?? {
          sellerId: item.sellerId,
          displayName: displayName(item.seller.membership.user, item.seller.businessName),
          ranges: [],
          ticketCount: 0,
          usedCount: 0,
        };
        entry.ticketCount++;
        if (!isUntouched(item)) entry.usedCount++;
        bySeller.set(item.sellerId, entry);
        numbers.set(item.sellerId, [...(numbers.get(item.sellerId) ?? []), n]);
      }
      for (const [sellerId, ns] of numbers) bySeller.get(sellerId)!.ranges = runsOf(ns);
    }

    return [...bySeller.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /**
   * Whose ticket this number already is, if any: the reason a create of it is
   * refused (D8). Null when no live item has it.
   */
  async takenBy(swapId: string, sku: string): Promise<{ sellerName: string | null } | null> {
    const item = await this.prisma.swapItem.findFirst({
      where: { swapId, sku, deletedAt: null },
      select: { seller: { include: { membership: { include: { user: true } } } } },
    });
    if (!item) return null;
    return { sellerName: item.seller ? displayName(item.seller.membership.user, item.seller.businessName) : null };
  }

  /** Whether this seller holds tickets in this swap, rather than printing tags. */
  async isLegacySeller(swapId: string, sellerId: string): Promise<boolean> {
    return (await this.heldBy(swapId, sellerId)).length > 0;
  }

  /**
   * What the shop's item form needs (Plan 38): the runs it holds, the lowest
   * ticket nobody has described yet, and whether every one is described.
   */
  async formState(
    swapId: string,
    sellerId: string,
  ): Promise<{ ranges: Range[]; suggested: number | null; exhausted: boolean; webTicketsOnly: boolean }> {
    const [held, swap] = await Promise.all([
      this.heldBy(swapId, sellerId),
      this.prisma.skiSwap.findUnique({ where: { id: swapId }, select: { allowLegacyWeb: true, allowPrintWeb: true } }),
    ]);
    // A swap whose web takes no legacy tickets offers none on the web, whatever
    // a seller holds (Plan 34): they're for staff there.
    const offered = swap?.allowLegacyWeb ? held : [];
    const untouched = offered.filter(isUntouched);
    return {
      ranges: runsOf(offered.map((t) => t.number)),
      suggested: untouched[0]?.number ?? null,
      exhausted: offered.length > 0 && untouched.length === 0,
      // The web takes legacy tickets only: no print tickets there.
      webTicketsOnly: swap ? !swap.allowPrintWeb : false,
    };
  }

  /**
   * One of this seller's tickets by its number, or a refusal saying why not
   * (D7): it has to be a ticket number, and one they hold.
   */
  async ownTicket(swapId: string, sellerId: string, sku: string): Promise<HeldTicket> {
    const n = ticketNumberOf(sku);
    if (n === null) throw new BadRequestException('A ticket number is just the digits on the ticket.');
    const held = await this.heldBy(swapId, sellerId);
    const ticket = held.find((t) => t.number === n);
    if (!ticket) {
      throw new BadRequestException(
        held.length
          ? `${n} isn’t one of your tickets. Yours are ${describe(runsOf(held.map((t) => t.number)))}.`
          : 'You have no tickets for this swap. Ask the organizer for a block.',
      );
    }
    return ticket;
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
  parseItemCsv(buffer: Buffer): { headers: string[]; rows: ImportFileRow[] } {
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
      // A quote inside a cell is kept as typed: a shop writes pole lengths as
      // 42", and a spreadsheet only quotes the cell when it exports it.
      records = parseCsv(buffer, { skip_empty_lines: true, trim: true, relax_quotes: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      const line = /(?:on|at) line (\d+)/.exec(message)?.[1] ?? '?';
      if ((err as { code?: string }).code === 'CSV_RECORD_INCONSISTENT_FIELDS_LENGTH') {
        throw new BadRequestException(
          `Line ${line} has more columns than the header. ` +
            'A name or description containing a comma has to be in quotes: "170cm, edges good".',
        );
      }
      throw new BadRequestException(`Line ${line} couldn’t be read: check its quotes. A cell that starts with a quote has to end with one.`);
    }
    if (!records.length) return { headers: [], rows: [] };

    const [rawHeaders, ...dataRows] = records;
    const headers = rawHeaders.map((h) => h.trim().toLowerCase());
    const indexOf = (aliases: string[]) => headers.findIndex((h) => aliases.includes(h));

    const skuAt = indexOf([...BASE_COLUMNS.sku]);
    const nameAt = indexOf([...BASE_COLUMNS.name]);
    const descAt = indexOf([...BASE_COLUMNS.description]);
    const priceAt = indexOf([...BASE_COLUMNS.price]);

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
      // Every cell, for the category and detail columns (Plan 42).
      cells: row,
    }));
    return { headers: rawHeaders, rows };
  }

  /**
   * Checks a whole file before anything is written (Plans 31, 38).
   *
   * Every row is judged before any of them lands: a half-imported inventory is
   * worse than a rejected one, because the seller cannot tell which half. A
   * result carrying any `error` means nothing should be written at all.
   *
   * A ticket row describes one of this seller's issued tickets (`itemId` says
   * which): the ticket already exists, so the row fills it in rather than
   * creating anything. From the shop's own file, only a ticket nobody has
   * described yet (D6). A row without a ticket gets a generated SKU when
   * `generateSkus` is on, and is an error otherwise.
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
    const held = await this.heldBy(swapId, sellerId);
    if (held.length === 0 && !rules.generateSkus) {
      throw new BadRequestException(
        rules.webTicketsOnly
          ? 'This seller has no tickets for this swap, and it takes legacy tickets only on the web.'
          : 'This seller has no tickets for this swap. Turn on “Generate SKUs as needed” to give each row a new SKU.',
      );
    }
    const byNumber = new Map(held.map((t) => [t.number, t]));
    const whose = rules.shopOwn ? 'your' : 'this seller’s';

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
      const ticket = byNumber.get(n);
      if (!ticket) {
        return fail(
          held.length
            ? `${n} isn’t one of ${whose} tickets. ${rules.shopOwn ? 'Yours' : 'Theirs'} are ${describe(runsOf(held.map((t) => t.number)))}.`
            : `${rules.shopOwn ? 'You have' : 'This seller has'} no tickets for this swap. Leave the ticket blank to generate a SKU.`,
        );
      }
      if (rules.shopOwn && !isUntouched(ticket)) {
        return fail(`${n} is already described. Ask the swap’s staff to change it.`);
      }

      const earlier = seen.get(sku);
      if (earlier !== undefined) return fail(`Ticket ${n} is also on line ${earlier}.`);
      seen.set(sku, line);

      results.push({ line, sku, outcome: 'ok', itemId: ticket.id });
    });

    return results;
  }
}

/** A price cell as cents: null when blank, NaN when it isn't an amount. */
function priceOf(cell: string): number | null {
  const digits = cell.replace(/[^0-9.]/g, '');
  if (cell.trim() === '') return null;
  return digits ? Math.round(parseFloat(digits) * 100) : NaN;
}
