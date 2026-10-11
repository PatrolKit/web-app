import type { ItemResponse, PickupResult, AwaitingPickupItems } from '../../lib/api.types';

/**
 * Pick up items' session (Plan 43), kept apart from the popover so it can be
 * tested: each scan is a row, newest first, that ends picked up or refused,
 * and says which on a banner that can't be missed.
 */

export type PickupOutcome =
  | 'sending'
  | 'picked_up'
  | 'already'
  | 'unchecked'
  | 'sold'
  | 'wrong_seller'
  | 'not_received'
  | 'not_found'
  | 'not_sent'
  | 'failed'
  | 'undone';

export interface PickupRow {
  /** Unique per scan, so the same tag scanned twice is two rows. */
  key: number;
  code: string;
  outcome: PickupOutcome;
  item?: ItemResponse;
  /** The server's sentence, for a refusal. */
  message?: string;
}

/** A scan or a typed code, trimmed; blank is nothing. It goes in first, sending. */
export function scanned(rows: PickupRow[], raw: string, key: number): { rows: PickupRow[]; code: string | null } {
  const code = raw.trim();
  if (!code) return { rows, code: null };
  return { rows: [{ key, code, outcome: 'sending' }, ...rows], code };
}

/** A retried row goes back to sending, where it stands in the list. */
export function resent(rows: PickupRow[], key: number): PickupRow[] {
  return rows.map((r) => (r.key === key ? { key, code: r.code, outcome: 'sending' } : r));
}

/** The server picked it up, or already had. */
export function landed(rows: PickupRow[], key: number, result: PickupResult): PickupRow[] {
  const outcome: PickupOutcome = result.outcome === 'already_picked_up' ? 'already' : result.squareChecked ? 'picked_up' : 'unchecked';
  return rows.map((r) => (r.key === key ? { ...r, outcome, item: result.item } : r));
}

/** A refusal, by the server's code; no status at all is the network. */
export function refused(rows: PickupRow[], key: number, err: { status?: number; code?: string; message?: string }): PickupRow[] {
  const outcome: PickupOutcome =
    err.code === 'ITEM_SOLD' ? 'sold'
      : err.code === 'WRONG_SELLER' ? 'wrong_seller'
        : err.code === 'NOT_RECEIVED' ? 'not_received'
          : err.code === 'ITEM_NOT_FOUND' || err.status === 404 ? 'not_found'
            : err.status === undefined ? 'not_sent'
              : 'failed';
  return rows.map((r) => (r.key === key ? { ...r, outcome, message: err.message } : r));
}

/** Put back on sale from this session's list. */
export function undone(rows: PickupRow[], key: number, item: ItemResponse): PickupRow[] {
  return rows.map((r) => (r.key === key ? { ...r, outcome: 'undone', item } : r));
}

/** Undo puts it back as it was, so not once any of it has sold (D4). */
export const canUndoPickup = (item: Pick<ItemResponse, 'pickedUpAt' | 'pickedUpUnits' | 'originalQuantity'>) =>
  !!item.pickedUpAt && (item.pickedUpUnits ?? item.originalQuantity) >= item.originalQuantity;

export const isPickedUp = (o: PickupOutcome) => o === 'picked_up' || o === 'already' || o === 'unchecked';
export const isRefused = (o: PickupOutcome) => o === 'sold' || o === 'wrong_seller' || o === 'not_received' || o === 'not_found' || o === 'not_sent' || o === 'failed';

/** "18 picked up · 2 refused": a double scan counts once. */
export function counts(rows: PickupRow[]): { pickedUp: number; refused: number } {
  const ids = new Set(rows.filter((r) => isPickedUp(r.outcome) && r.item).map((r) => r.item!.id));
  return { pickedUp: ids.size, refused: rows.filter((r) => isRefused(r.outcome)).length };
}

/** A locked seller's items still out, less what this session has picked up since the list was read. */
export function stillOut(list: AwaitingPickupItems['items'], rows: PickupRow[]): AwaitingPickupItems['items'] {
  const back = new Set(rows.filter((r) => isPickedUp(r.outcome) && r.item).map((r) => r.item!.id));
  return list.filter((i) => !back.has(i.id));
}

export type BannerKind = 'ready' | 'warn' | 'error';

/** What the big banner says about a row. */
export function bannerFor(row: PickupRow): { tone: BannerKind; title: string; text: string } | null {
  const seller = row.item?.seller?.displayName ?? 'its seller';
  const what = row.item ? `${row.item.sku} · ${row.item.name}` : row.code;
  switch (row.outcome) {
    case 'sending': return null;
    case 'picked_up': return { tone: 'ready', title: `Picked up by ${seller}`, text: what };
    case 'already': {
      const at = row.item?.pickedUpAt
        ? new Date(row.item.pickedUpAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : null;
      return { tone: 'ready', title: `Already picked up by ${seller}`, text: `${what}${at ? ` · at ${at}` : ''}${row.item?.pickedUpBy ? ` by ${row.item.pickedUpBy}` : ''}` };
    }
    case 'unchecked':
      return { tone: 'warn', title: `Picked up by ${seller}`, text: `${what}. Couldn’t check Square: if it sold, find the buyer’s receipt.` };
    case 'undone': return { tone: 'warn', title: 'Back on sale', text: `${what} is in Square again.` };
    case 'sold': return { tone: 'error', title: 'Sold: not picked up', text: `${row.code}. ${row.message ?? 'Square says this sold.'}` };
    case 'wrong_seller': return { tone: 'error', title: 'Not this seller’s item', text: `${row.code}. ${row.message ?? 'Not picked up.'}` };
    case 'not_received': return { tone: 'error', title: 'Never accepted: not picked up', text: `${row.code}. ${row.message ?? 'It was never on sale.'}` };
    case 'not_found': return { tone: 'error', title: 'Not found', text: `${row.code}: no item has this SKU in this swap.` };
    case 'not_sent': return { tone: 'error', title: 'Not sent: not picked up', text: `${row.code}. Couldn’t reach PatrolKit. Retry it from the list.` };
    case 'failed': return { tone: 'error', title: 'Not picked up', text: `${row.code}: ${row.message ?? 'Something went wrong.'}` };
  }
}
