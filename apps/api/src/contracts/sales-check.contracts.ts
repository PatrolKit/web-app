import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * Sales check (Plan 48): sale lines in Square that aren't on this swap's items,
 * and what staff decide about each. Reading changes nothing (D13); every
 * decision below is a person's choice, made by an admin.
 */

export const SALES_CHECK_KINDS = ['other_copy', 'register_item', 'scanned_twice', 'unknown_ticket', 'custom_amount', 'other_item', 'oversold', 'double_fee', 'cash_fee'] as const;
export type SalesCheckKind = (typeof SALES_CHECK_KINDS)[number];

const line = { orderId: z.string().min(1).max(64), lineUid: z.string().min(1).max(64) };

export const CreditSaleSchema = z.object({
  ...line,
  itemId: z.string().min(1),
  /** D6: also set the item's Square stock, so it reads as sold. */
  markSold: z.boolean().default(true),
  /** An unpriced item takes this price too (in cents), in PatrolKit and Square. */
  priceCents: z.number().int().positive().max(10_000_000).optional(),
  /** With `priceCents`: a priced item takes it too, over the price it has (Square's, when they differ). */
  replacePrice: z.boolean().optional(),
}).strict();
export class CreditSaleDto extends createZodDto(CreditSaleSchema) {}

export const NotSwapSaleSchema = z.object({ ...line, note: z.string().max(500).optional() }).strict();
export class NotSwapSaleDto extends createZodDto(NotSwapSaleSchema) {}

/** A fee check refunded some way Square doesn't show (Plan 48 fee check). */
export const FeeHandledSchema = z.object({ orderId: z.string().min(1).max(64) }).strict();
export class FeeHandledDto extends createZodDto(FeeHandledSchema) {}

export const IgnoreCategorySchema = z.object({ categoryId: z.string().min(1).max(64), ignore: z.boolean() }).strict();
export class IgnoreCategoryDto extends createZodDto(IgnoreCategorySchema) {}

export const IssueAndCreditSchema = z.object({
  ...line,
  sellerId: z.string().min(1),
  ticket: z.string().regex(/^\d{1,9}$/, 'A ticket number is digits only.'),
}).strict();
export class IssueAndCreditDto extends createZodDto(IssueAndCreditSchema) {}

/** D13: exactly the lines the confirmation listed; nothing is recomputed. */
export const CreditSuggestedSchema = z.object({
  lines: z.array(z.object({ ...line, itemId: z.string().min(1) }).strict()).min(1).max(500),
  markSold: z.boolean().default(true),
}).strict();
export class CreditSuggestedDto extends createZodDto(CreditSuggestedSchema) {}

export interface SalesCheckRungUpAs {
  name: string;
  sku: string;
  variationId: string;
  itemId: string | null;
  category: string | null;
  archived: boolean;
}

export interface SalesCheckIssue {
  key: string;
  kind: SalesCheckKind;
  orderId: string;
  lineUid: string;
  soldAt: string;
  quantity: number;
  refundedQuantity: number;
  collectedCents: number;
  unitPriceCents: number | null;
  rungUpAs: SalesCheckRungUpAs | null;
  suggestion: { itemId: string; sku: string; name: string; priceCents: number | null; sellerName: string | null; sellerId: string | null } | null;
  ticket: string | null;
  oversold?: { itemId: string; sku: string; name: string; units: number; quantity: number; orders: string[] };
  /** The item's categories, for "Never count …" (other_item). */
  categoryIds: string[];
  links: { sale: string | null; item: string | null };
  /** The sale's receipt number, as printed and searched on the POS ("Gq00"). */
  receipt: string | null;
  /** double_fee, cash_fee: the sale's fees, and what to refund (`collectedCents` too). */
  fee?: {
    shopFeeName: string;
    shopFeeCents: number;
    /** Square's credit card surcharge, when charged too. */
    surchargeCents: number | null;
    cardCents: number;
    cashCents: number;
    refundCents: number;
  };
}

export interface SalesCheckDecided {
  id: string;
  key: string;
  decision: 'CREDIT' | 'NOT_SWAP' | 'FEE_HANDLED';
  orderId: string;
  lineUid: string;
  collectedCents: number;
  item: { id: string; sku: string; name: string } | null;
  note: string | null;
  markedSold: boolean;
  decidedBy: string | null;
  decidedAt: string;
  links: { sale: string | null };
}

export interface SalesCheckResponse {
  /** When Square's sales were read. */
  asOf: string;
  /** Square couldn't be read: nothing to check yet. */
  error: string | null;
  issues: SalesCheckIssue[];
  decided: SalesCheckDecided[];
  ignoredCategories: { id: string; name: string }[];
  /** Card sales charged no fee: counted, not flagged. Null when fees weren't read. */
  missedFees: { orders: number; cardCents: number; feeCents: number | null; percentage: string | null } | null;
}

export interface SalesCheckOutcome {
  key: string;
  ok: boolean;
  error?: string;
  /** Crediting set the item's Square stock (D6). */
  markedSold?: boolean;
  /** The price the item took with it, when one was asked for. */
  pricedCents?: number;
  /** The sale was accepted, but the price couldn't be set (say, it was priced meanwhile). */
  priceError?: string;
}

export interface SalesCheckCount {
  open: number;
  error: string | null;
}
