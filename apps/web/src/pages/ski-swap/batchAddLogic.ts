import {
  normalizedTicket, takenRejection, ticketScanRejection, type TicketScanRejection,
} from '@patrolkit/contracts/legacy-ticket-scan';

/**
 * Batch add's list (Plan 40), kept apart from the popover so it can be tested:
 * what a scan does, what the server's check does, and what Save's refusal
 * marks.
 */

export interface BatchTicket {
  sku: string;
  /**
   * `checking` while the server says whether it's free; `ok` once it has (or
   * couldn't be asked, since Save checks again); `taken` when Save found it
   * taken since, to be removed.
   */
  status: 'checking' | 'ok' | 'taken';
  holder?: string | null;
}

export interface BatchState {
  /** Newest first. */
  tickets: BatchTicket[];
  /** The last ticket that went in. */
  last: string | null;
  /** Why the last scan was refused, until the next good one. */
  rejection: TicketScanRejection | null;
}

export const emptyBatch: BatchState = { tickets: [], last: null, rejection: null };

/**
 * A scan or a typed number. Refused on the spot when the page can tell (D7);
 * otherwise it goes in as `checking`, and `check` is the SKU to ask about.
 */
export function scanned(state: BatchState, raw: string): { state: BatchState; check: string | null } {
  const sku = normalizedTicket(raw);
  if (!sku) return { state, check: null };
  const rejection = ticketScanRejection(sku, new Set(state.tickets.map((t) => t.sku)));
  if (rejection) return { state: { ...state, rejection }, check: null };
  return {
    state: { tickets: [{ sku, status: 'checking' }, ...state.tickets], last: sku, rejection: null },
    check: sku,
  };
}

/** The server's answer for one ticket: free stays; taken comes out, said as a refusal. */
export function checked(state: BatchState, sku: string, result: { free: true } | { free: false; holder: string | null }): BatchState {
  if (!state.tickets.some((t) => t.sku === sku)) return state; // removed meanwhile
  if (result.free) {
    return { ...state, tickets: state.tickets.map((t) => (t.sku === sku ? { ...t, status: 'ok' } : t)) };
  }
  const tickets = state.tickets.filter((t) => t.sku !== sku);
  return {
    tickets,
    last: state.last === sku ? tickets[0]?.sku ?? null : state.last,
    rejection: takenRejection(sku, result.holder),
  };
}

/** The check couldn't be asked (the network): kept, since Save checks again. */
export function uncheckable(state: BatchState, sku: string): BatchState {
  return { ...state, tickets: state.tickets.map((t) => (t.sku === sku && t.status === 'checking' ? { ...t, status: 'ok' } : t)) };
}

/** A mis-scan taken out by hand. */
export function removed(state: BatchState, sku: string): BatchState {
  const tickets = state.tickets.filter((t) => t.sku !== sku);
  return { ...state, tickets, last: state.last === sku ? tickets[0]?.sku ?? null : state.last };
}

/** Save's refusal (D11): these were taken since they were scanned, and are marked to remove. */
export function markedTaken(state: BatchState, taken: { sku: string; holder: string | null }[]): BatchState {
  const bySku = new Map(taken.map((t) => [t.sku, t.holder]));
  return {
    ...state,
    tickets: state.tickets.map((t) => (bySku.has(t.sku) ? { ...t, status: 'taken', holder: bySku.get(t.sku) ?? null } : t)),
  };
}

/** What Save sends: every ticket, oldest first, as they were scanned. */
export const toSave = (state: BatchState): string[] => state.tickets.map((t) => t.sku).reverse();
