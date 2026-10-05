/**
 * Whether a scanned or typed code can be a legacy ticket (Plan 40 D7).
 *
 * A port of the iPad's `LegacyTicketRules.swift`, so the web's batch add and
 * the iPad's refuse the same pieces of paper, in the same words. Free of
 * imports so the web can use it as is. Whether the ticket is already an item
 * is the server's to say (`ticket-check`), and isn't here.
 */

export type TicketScanRejection =
  /** One of our minted SKUs, `PREFIX-C-NNNN`. */
  | { key: 'ourTag'; headline: string; advice: string }
  /** Not all digits: a barcode off the gear, a membership card, a label. */
  | { key: 'notDigits'; headline: string; advice: string }
  /** Scanned once already in this batch. */
  | { key: 'inBatch'; headline: string; advice: string; ticket: string }
  /** On an item in this swap already. `holder` is its seller, when known. */
  | { key: 'taken'; headline: string; advice: string; ticket: string; holder: string | null };

/** The ticket as scanned or typed, or null for nothing at all. */
export function normalizedTicket(raw: string): string | null {
  const ticket = raw.trim();
  return ticket === '' ? null : ticket;
}

/**
 * Our minted SKUs are `PREFIX-C-NNNN`. Told apart by shape rather than by
 * symbology, because a scanner with code IDs switched off gives the payload
 * and nothing else. Every ticket is a plain number, so no real one can match.
 */
export function looksLikeOurSku(value: string): boolean {
  const parts = value.split('-');
  return parts.length === 3 && parts[0] !== '' && parts[1].length === 1 && /^\d+$/.test(parts[2]);
}

/**
 * Why this can't be a ticket in the batch, or null when it can (as far as the
 * page can tell). In the order the mistakes happen at a counter.
 */
export function ticketScanRejection(ticket: string, inBatch: ReadonlySet<string>): TicketScanRejection | null {
  if (looksLikeOurSku(ticket)) {
    return { key: 'ourTag', headline: 'Not a legacy ticket', advice: 'That’s a PatrolKit tag. Use Add item for it.' };
  }
  if (!/^\d+$/.test(ticket)) {
    return { key: 'notDigits', headline: 'Not a ticket number', advice: 'A ticket number is digits only. Scan the number on the ticket.' };
  }
  if (inBatch.has(ticket)) {
    return { key: 'inBatch', headline: 'Already in this batch', advice: 'It’s already in the list below.', ticket };
  }
  return null;
}

/** The refusal for a ticket that's already an item: the server's own sentence. */
export function takenRejection(ticket: string, holder: string | null): TicketScanRejection {
  return {
    key: 'taken',
    headline: holder ? 'Already taken' : 'Already checked in',
    advice: holder ? `Ticket ${ticket} belongs to ${holder}.` : `Ticket ${ticket} is already on another item in this swap.`,
    ticket,
    holder,
  };
}
