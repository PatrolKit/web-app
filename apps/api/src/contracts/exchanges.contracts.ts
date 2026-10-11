import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * Exchanges (Plan 49): a customer handed back an item they bought and left
 * with another. Recorded at the counter; every reader then counts the sale on
 * the item that went out, and Square's stock moves to match. No money changes
 * hands. Reading needs `ski_swap:report`; every change needs `ski_swap:admin`.
 */

export const RecordExchangeSchema = z.object({
  /** The Square sale line exchanged, as the lookup found it. */
  orderId: z.string().min(1).max(64),
  lineUid: z.string().min(1).max(64),
  /** The item the lookup said the line counts for: refused if that changed since. */
  returnedItemId: z.string().min(1),
  replacementItemId: z.string().min(1),
  /** D7: the price for an unpriced item going out. Refused for a priced one. */
  priceCents: z.number().int().positive().max(10_000_000).optional(),
  note: z.string().max(500).optional(),
}).strict();
export class RecordExchangeDto extends createZodDto(RecordExchangeSchema) {}

export const EditExchangeSchema = z.object({
  /** Empty clears it. */
  note: z.string().max(500),
}).strict();
export class EditExchangeDto extends createZodDto(EditExchangeSchema) {}

export const CancelExchangeSchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();
export class CancelExchangeDto extends createZodDto(CancelExchangeSchema) {}

export interface ExchangeItem {
  id: string;
  sku: string;
  name: string;
  /** Listed price now. */
  priceCents: number | null;
  sellerId: string | null;
  sellerName: string | null;
  deleted: boolean;
}

export type ExchangeStatus = 'live' | 'superseded' | 'cancelled';

export interface SwapExchangeResponse {
  id: string;
  status: ExchangeStatus;
  orderId: string;
  lineUid: string;
  receipt: string | null;
  returned: ExchangeItem;
  replacement: ExchangeItem;
  /** Listed prices when recorded (null = unpriced). */
  returnedPriceCents: number | null;
  replacementPriceCents: number | null;
  /** Going out less coming back: above 0 the patrol absorbed it, below 0 kept it. Null when either was unpriced. */
  differenceCents: number | null;
  note: string | null;
  /** False: Square's stock wasn't updated (D5), and Retry is offered. */
  stockSynced: boolean;
  supersedesId: string | null;
  /** The exchange that replaced this one in a chain (D10). */
  supersededById: string | null;
  recordedByName: string | null;
  recordedAt: string;
  cancelledByName: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  links: { sale: string | null };
}

export interface ExchangesResponse {
  exchanges: SwapExchangeResponse[];
  /** Across live exchanges: what the patrol absorbed (going out cost more) and kept (cost less). */
  totals: { live: number; absorbedCents: number; keptCents: number };
}

/** A sale line the lookup found (D3): the item it counts for now, and any live exchange. */
export interface ExchangeLookupLine {
  orderId: string;
  lineUid: string;
  receipt: string | null;
  soldAt: string;
  collectedCents: number;
  item: ExchangeItem;
  /** Its live exchange: picking this line chains onto it (D10). */
  exchange: { id: string; returnedSku: string } | null;
  /** D12: a payout run past draft already paid this item on this sale. */
  paidInRun: { runId: string; status: string } | null;
  links: { sale: string | null };
}

export interface ExchangeLookupResponse {
  lines: ExchangeLookupLine[];
  error: string | null;
}

export interface RecordExchangeResponse {
  exchange: SwapExchangeResponse;
  /** Square's stock wasn't updated: why. The exchange is saved either way. */
  stockError: string | null;
  /** D7: the price set on the item going out. */
  pricedCents: number | null;
}
