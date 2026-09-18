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

// ─── Runs (§5) ────────────────────────────────────────────────────────────────

export const CreatePayoutRunSchema = z
  .object({
    /**
     * The sales window. Defaults to the swap's own dates, but a swap that ran
     * late needs to be able to say so.
     */
    salesFrom: z.string().datetime().optional(),
    salesTo: z.string().datetime().optional(),
  })
  .strict();

export class CreatePayoutRunDto extends createZodDto(CreatePayoutRunSchema) {}

export const ApproveLinesSchema = z
  .object({
    lineIds: z.array(z.string().min(1)).min(1).max(2000),
    /** False un-approves, for a line approved by mistake before anything sent. */
    approved: z.boolean().default(true),
  })
  .strict();

export class ApproveLinesDto extends createZodDto(ApproveLinesSchema) {}

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

export const RecordCheckSchema = z
  .object({
    checkNumber: z.string().max(40).nullish(),
    /** Null clears a mark made in error. */
    sentAt: z.string().datetime().nullish(),
  })
  .strict();

export class RecordCheckDto extends createZodDto(RecordCheckSchema) {}

// ─── Read models ──────────────────────────────────────────────────────────────

export const PAYOUT_LINE_STATUSES = [
  'PENDING',
  'APPROVED',
  'SENDING',
  'SENT',
  'UNCLAIMED',
  'FAILED',
  'RETURNED',
  'PAID_BY_CHECK',
  'DONATED',
  'BELOW_MINIMUM',
] as const;

export type PayoutLineStatus = (typeof PAYOUT_LINE_STATUSES)[number];

/** Statuses a line can never leave once it has arrived: the money moved. */
export const TERMINAL_PAYOUT_STATUSES: readonly PayoutLineStatus[] = [
  'SENT',
  'RETURNED',
  'PAID_BY_CHECK',
  'DONATED',
];
