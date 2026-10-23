import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * The shapes the payouts feature speaks in (Plan 25).
 *
 * Its own file rather than another six hundred lines of ski-swap.contracts.ts,
 * following receipt.contracts.ts. Money has enough of a surface to be worth
 * finding in one place.
 */

// ─── PayPal credentials (§6) ──────────────────────────────────────────────────

export const UpsertPayPalConfigSchema = z
  .object({
    clientId: z.string().min(1).max(200),
    clientSecret: z.string().min(1).max(200),
    environment: z.enum(['sandbox', 'live']).default('sandbox'),
    /**
     * Optional at first save: the webhook cannot be registered with PayPal
     * until they have somewhere to send it, which is after these credentials
     * exist. A second save fills it in.
     */
    webhookId: z.string().max(100).nullish(),
  })
  .strict();

/**
 * What comes back. There is no `clientSecret` field at all — not masked, not
 * nulled — because a field that sometimes holds a secret is a field that will
 * one day be logged with one in it.
 */
export const PayPalConfigResponseSchema = z.object({
  orgId: z.string(),
  clientId: z.string(),
  environment: z.enum(['sandbox', 'live']),
  webhookId: z.string().nullable(),
  /** Whether a secret is stored, which is all anybody needs to know about it. */
  hasSecret: z.boolean(),
  updatedAt: z.string().datetime(),
});

export class UpsertPayPalConfigDto extends createZodDto(UpsertPayPalConfigSchema) {}
export type PayPalConfigResponse = z.infer<typeof PayPalConfigResponseSchema>;

// ─── Commission (§3) ──────────────────────────────────────────────────────────

/**
 * A percentage, as a person types one: "15", "15.5", "15.5%".
 *
 * Basis points are how the arithmetic is done and stored; they are not a thing
 * anybody should have to know to run a swap. Conversion happens at this edge
 * and nowhere else.
 */
export const PercentSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?%?$/, 'Enter a percentage, like 15 or 12.5')
  .or(z.number().min(0).max(100));

// ─── Runs (Plan 52) ───────────────────────────────────────────────────────────

export const PAYOUT_RUN_KINDS = ['CHECK', 'PAYPAL'] as const;
export type PayoutRunKind = (typeof PAYOUT_RUN_KINDS)[number];

/** A run starts empty and has a kind, never changed (D1, D2). */
export const CreatePayoutRunSchema = z.object({ kind: z.enum(PAYOUT_RUN_KINDS) }).strict();
export class CreatePayoutRunDto extends createZodDto(CreatePayoutRunSchema) {}

export const AddPayoutSellersSchema = z.object({ sellerIds: z.array(z.string().min(1)).min(1).max(2000) }).strict();
export class AddPayoutSellersDto extends createZodDto(AddPayoutSellersSchema) {}

/** One seller at a time: there's no bulk approve (D7). False unapproves. */
export const ApproveLineSchema = z.object({ approved: z.boolean() }).strict();
export class ApproveLineDto extends createZodDto(ApproveLineSchema) {}

/**
 * Approve all: exactly the sellers the confirmation listed, each with the
 * total it showed. One whose total has changed since, or who is flagged now,
 * is left for review rather than approved at a total nobody saw.
 */
export const ApproveAllSchema = z.object({
  lines: z.array(z.object({ lineId: z.string().min(1).max(40), netCents: z.number().int() }).strict()).min(1).max(2000),
}).strict();
export class ApproveAllDto extends createZodDto(ApproveAllSchema) {}

/** The Payouts export, emailed: the swap's or a run's, to the address typed. */
export const EmailPayoutsExportSchema = z.object({ to: z.string().trim().email().max(254) }).strict();
export class EmailPayoutsExportDto extends createZodDto(EmailPayoutsExportSchema) {}

export const SendPayoutRunSchema = z
  .object({
    /**
     * The count of approved lines, as the screen showed it. If the server
     * disagrees, something changed between looking and clicking and the send
     * is refused — the one confirmation that money is worth.
     */
    expectedLineCount: z.number().int().min(0),
  })
  .strict();
export class SendPayoutRunDto extends createZodDto(SendPayoutRunSchema) {}

/** A change after payment, settled outside PatrolKit (D9). */
export const SettlePayoutLineSchema = z.object({ note: z.string().trim().min(1).max(500) }).strict();
export class SettlePayoutLineDto extends createZodDto(SettlePayoutLineSchema) {}

/** PayPal's fee rate, for the funding estimate (D17). */
export const PayPalFeeRateSchema = z
  .object({
    flatCents: z.number().int().min(0).max(10_000),
    bps: z.number().int().min(0).max(10_000),
    capCents: z.number().int().min(0).max(100_000),
  })
  .strict();
export class PayPalFeeRateDto extends createZodDto(PayPalFeeRateSchema) {}

// ─── Read models ──────────────────────────────────────────────────────────────

export const PAYOUT_LINE_STATUSES = [
  /** Needs review. */
  'PENDING',
  'APPROVED',
  /** Handed to PayPal, no answer yet. */
  'SENDING',
  /** PayPal confirmed it arrived. */
  'SENT',
  'UNCLAIMED',
  'ONHOLD',
  'FAILED',
  'RETURNED',
  /** An unclaimed payment cancelled at PayPal (D19). */
  'CANCELLED',
  /** In a closed check run's spreadsheet (D13). */
  'EXPORTED',
] as const;

export type PayoutLineStatus = (typeof PAYOUT_LINE_STATUSES)[number];

/** Statuses a line can never leave once it has arrived. */
export const TERMINAL_PAYOUT_STATUSES: readonly PayoutLineStatus[] = ['SENT', 'FAILED', 'RETURNED', 'CANCELLED', 'EXPORTED'];

/** A payment that ended without paying them: it frees the seller for another run (D4, D19). */
export const NOT_PAID_STATUSES: readonly PayoutLineStatus[] = ['FAILED', 'RETURNED', 'CANCELLED'];

export interface PayoutFlag { text: string; fix: string }

export interface PayoutLineItemView {
  itemId: string | null;
  sku: string;
  name: string;
  priceCents: number;
  quantity: number;
  collectedCents: number;
  donated: boolean;
  soldAt: string;
  receipt: string | null;
  saleUrl: string | null;
  /** A comp (Plan 53): sold with no Square sale, so no receipt or link. */
  comp: { reason: string; note: string } | null;
}

export interface PayoutTotals { items: number; grossCents: number; commissionCents: number; netCents: number }

export interface PayoutLineView {
  id: string;
  sellerId: string;
  sellerName: string;
  business: boolean;
  method: string | null;
  /** The PayPal email or Venmo handle, or for a check the mailing address. */
  destination: string | null;
  status: PayoutLineStatus;
  statusNote: string | null;
  /** Live until frozen (D6). */
  frozen: boolean;
  frozenAt: string | null;
  commissionBasisPoints: number;
  totals: PayoutTotals;
  items: PayoutLineItemView[];
  flags: PayoutFlag[];
  approvedNetCents: number | null;
  /** D9: live net minus what was paid, once frozen and paid; 0 when settled or unchanged. */
  changedSincePaidCents: number;
  settled: { note: string; at: string; by: string | null } | null;
  paypal: { itemId: string | null; transactionId: string | null; paidAt: string | null } | null;
  /** Earlier runs where PayPal didn't pay them (D19). */
  notPaidBefore: { runId: string; createdAt: string; status: PayoutLineStatus; reason: string | null }[];
  /** "Remind them" was used: when (D19). */
  remindedAt: string | null;
}

export interface PayoutRunView {
  id: string;
  swapId: string;
  swapTitle: string;
  kind: PayoutRunKind;
  status: 'OPEN' | 'CLOSED';
  createdAt: string;
  closedAt: string | null;
  sendingLocked: boolean;
  /** Sent and PayPal didn't answer: Send again re-posts the same batch (D19). */
  awaitingAnswer: boolean;
  batch: { id: string | null; status: string | null; feesCents: number | null; reason: string | null } | null;
  /** PayPal's fee rate, for the funding line (D17). */
  feeRate: { flatCents: number; bps: number; capCents: number };
  /** Sales couldn't be read: lines show no live amounts. */
  salesError: string | null;
  lines: PayoutLineView[];
}

export interface PayoutRunSummaryView {
  id: string;
  kind: PayoutRunKind;
  status: 'OPEN' | 'CLOSED';
  createdAt: string;
  closedAt: string | null;
  lineCount: number;
  flaggedCount: number;
  totalNetCents: number;
}

export interface PayoutSellerChoice {
  sellerId: string;
  name: string;
  business: boolean;
  method: string;
  destination: string | null;
  items: number;
  netCents: number;
  flags: PayoutFlag[];
  notPaidBefore: boolean;
}

export interface PayoutsSummaryView {
  swapId: string;
  swapTitle: string;
  salesError: string | null;
  /** Incoming, outgoing and profit; null when Square couldn't be read. See ski-swap/payouts/money-summary.ts. */
  money: {
    incoming: {
      salesCents: number; returnsCents: number; feesChargedCents: number; squareFeesCents: number; totalCents: number;
      /** Square's fees by how the card was taken, and what refunds returned; null when only the total is known. */
      squareFeesDetail: {
        kinds: { kind: 'in_person' | 'keyed' | 'on_file' | 'other'; payments: number; amountCents: number; feeCents: number }[];
        returnedCents: number;
      } | null;
    };
    outgoing: { itemsCents: number; compsCents: number; takeBps: number; takeCents: number; totalCents: number; donatedCents: number };
    profitCents: number;
    profitShare: number | null;
  } | null;
  runs: PayoutRunSummaryView[];
  /** D16: sellers with sales whose details stop their own payout method. */
  missingDetails: { sellerId: string; name: string; key: string; problem: string; fix: string }[];
  /** D14: open Sales check issues by seller, and sales that matched no ticket. */
  salesCheck: {
    bySeller: { sellerId: string; name: string; sku: string | null; text: string }[];
    unmatched: { receipt: string | null; soldAt: string; name: string; collectedCents: number; saleUrl: string | null }[];
  };
  /** D19: sellers PayPal didn't pay, not in another run yet. */
  notPaid: { sellerId: string; name: string; runId: string; createdAt: string; status: PayoutLineStatus; reason: string | null }[];
  /** D9 */
  changedSincePaid: { runId: string; sellerId: string; name: string; diffCents: number }[];
  discounts: { sku: string; name: string; sellerName: string; listedCents: number; collectedCents: number }[];
  donated: { sellerId: string; name: string; items: number; grossCents: number }[];
  /** Live comps (Plan 53 D10): units, and what sellers are owed on them before the patrol's share. */
  comps: { count: number; totalCents: number };
  /** How many can be added to a run of each kind now. */
  ready: { CHECK: number; PAYPAL: number };
}
