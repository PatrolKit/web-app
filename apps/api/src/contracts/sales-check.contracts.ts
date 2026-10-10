import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * Sales check (Plan 48): sale lines in Square that aren't on this swap's items,
 * and what staff decide about each. Reading changes nothing (D13); every
 * decision below is a person's choice, made by an admin.
 */

export const SALES_CHECK_KINDS = ['other_copy', 'register_item', 'unknown_ticket', 'custom_amount', 'other_item', 'oversold'] as const;
export type SalesCheckKind = (typeof SALES_CHECK_KINDS)[number];

const line = { orderId: z.string().min(1).max(64), lineUid: z.string().min(1).max(64) };

export const CreditSaleSchema = z.object({
  ...line,
  itemId: z.string().min(1),
  /** D6: also set the item's Square stock, so it reads as sold. */
  markSold: z.boolean().default(true),
}).strict();
export class CreditSaleDto extends createZodDto(CreditSaleSchema) {}

export const NotSwapSaleSchema = z.object({ ...line, note: z.string().max(500).optional() }).strict();
export class NotSwapSaleDto extends createZodDto(NotSwapSaleSchema) {}

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
}

export interface SalesCheckDecided {
  id: string;
  key: string;
  decision: 'CREDIT' | 'NOT_SWAP';
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
}

export interface SalesCheckOutcome {
  key: string;
  ok: boolean;
  error?: string;
  /** Crediting set the item's Square stock (D6). */
  markedSold?: boolean;
}

export interface SalesCheckCount {
  open: number;
  error: string | null;
}
