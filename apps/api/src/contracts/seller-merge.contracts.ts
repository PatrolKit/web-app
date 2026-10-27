import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * Merging two sellers who are one seller (Plan 57). The kept seller keeps their
 * own name, contacts and sign-in; these say what else comes from the other (D3).
 */
export const SellerMergeChoicesSchema = z
  .object({
    address: z.enum(['keep', 'other']),
    payout: z.enum(['keep', 'other']),
    businessName: z.enum(['keep', 'other', 'none']),
  })
  .strict();
export type SellerMergeChoices = z.infer<typeof SellerMergeChoicesSchema>;

export const MergeSellersSchema = z
  .object({
    /** The seller retired into this one. */
    otherSellerId: z.string().min(1),
    choices: SellerMergeChoicesSchema,
    /**
     * What the preview showed. If either changed since, the merge is refused
     * and the admin looks again (D7).
     */
    expected: z.object({ items: z.number().int().min(0), payoutLines: z.number().int().min(0) }).strict(),
  })
  .strict();
export class MergeSellersDto extends createZodDto(MergeSellersSchema) {}
export type MergeSellersRequest = z.infer<typeof MergeSellersSchema>;

/** One side of the merge, as the dialog's card shows it. */
export interface SellerMergeSide {
  sellerId: string;
  displayName: string;
  businessName: string | null;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  /** "Venmo @handle (scanned)", "Check", "PayPal: a@b.c", or null when not set. */
  payout: string | null;
  address: string | null;
  items: number;
  createdAt: string;
}

/** What happens to one payout line (D4). */
export type SellerMergeLineEffect =
  /** The other seller's line in an open run, taken out of it. */
  | 'removed'
  /** The kept seller's approved line: its total changes, so it needs review again. */
  | 'unapproved'
  /** Untouched. */
  | 'stays'
  /** A failed, returned or cancelled payment of the other seller: paid nothing, kept as history. */
  | 'history'
  /** The other seller's money has moved: the merge is refused. */
  | 'blocks';

export interface SellerMergeLine {
  lineId: string;
  runId: string;
  /** "Check run, Oct 27" */
  runLabel: string;
  seller: 'keep' | 'other';
  status: string;
  effect: SellerMergeLineEffect;
}

export interface SellerMergePreviewResponse {
  keep: SellerMergeSide;
  other: SellerMergeSide;
  /** Which of the two looks like the one to keep: verified contacts, then more of them, then the older. */
  suggestedKeepId: string;
  /** What moves from the other seller to the kept one. */
  moves: { items: number; receipts: number; printJobs: number; printers: number };
  /** Items per swap, so a merge across swaps is visible. */
  itemsBySwap: { swapId: string; title: string; keep: number; other: number }[];
  payoutLines: SellerMergeLine[];
  /** D3: what can be taken from the other seller. A choice that can't is said why. */
  choices: {
    address: { keep: string | null; other: string | null; offered: boolean };
    payout: { keep: string | null; other: string | null; offered: boolean; why: string | null };
    businessName: { keep: string | null; other: string | null };
  };
  /** Kept-seller swaps already paid, where moved items will read "Changed since paid". */
  paidSwaps: string[];
  /** Reasons the merge can't happen. Empty when it can. */
  refusals: string[];
  /** To send back with the merge (D7). */
  expected: { items: number; payoutLines: number };
}

export interface SellerMergeResult {
  keptSellerId: string;
  retiredSellerId: string;
  moved: { items: number; receipts: number; printJobs: number; printers: number };
  linesRemoved: number;
  linesUnapproved: number;
}
