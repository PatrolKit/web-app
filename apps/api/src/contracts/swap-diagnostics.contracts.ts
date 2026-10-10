import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import {
  DIAGNOSTIC_CHOICES, DIAGNOSTIC_FIELDS, DIAGNOSTIC_ISSUE_KINDS,
  type DiagnosticChoice, type DiagnosticField, type DiagnosticIssueKind,
} from './swap-diagnostics-choices';

/**
 * Swap diagnostics (Plan 41): our items against the swap's Square category,
 * matched by SKU, and what staff choose to do about each disagreement.
 */

export {
  CHOICES_FOR, DIAGNOSTIC_CHOICES, DIAGNOSTIC_FIELDS, DIAGNOSTIC_ISSUE_KINDS,
} from './swap-diagnostics-choices';
export type { DiagnosticChoice, DiagnosticField, DiagnosticIssueKind } from './swap-diagnostics-choices';

export const ApplyDiagnosticChoiceSchema = z
  .object({
    choice: z.enum(DIAGNOSTIC_CHOICES),
    /** Copy to PatrolKit: whose item it is. */
    sellerId: z.string().min(1).optional(),
    /** Copy to PatrolKit: restore this deleted item of ours instead. */
    restoreItemId: z.string().min(1).optional(),
    /** Keep this copy: the Square item to keep. */
    keepSquareItemId: z.string().min(1).optional(),
    /** Re-number the other item (Plan 48 D11): the prefix, when its category isn't named for a year. */
    prefix: z.string().regex(/^[A-Za-z0-9]{1,12}$/, 'Letters and digits, up to 12.').optional(),
    /** Set a new price: in cents, for PatrolKit and Square both. */
    priceCents: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();
export class ApplyDiagnosticChoiceDto extends createZodDto(ApplyDiagnosticChoiceSchema) {}

export const ApplyDiagnosticChoiceToAllSchema = z
  .object({
    kind: z.enum(DIAGNOSTIC_ISSUE_KINDS),
    /** Differs only: which field's group. */
    field: z.enum(DIAGNOSTIC_FIELDS).optional(),
    choice: z.enum(DIAGNOSTIC_CHOICES),
    /** Copy to PatrolKit: one seller for every item not restored. */
    sellerId: z.string().min(1).optional(),
    /** Re-number the other item (Plan 48 D11): the prefix, when its category isn't named for a year. */
    prefix: z.string().regex(/^[A-Za-z0-9]{1,12}$/, 'Letters and digits, up to 12.').optional(),
  })
  .strict();
export class ApplyDiagnosticChoiceToAllDto extends createZodDto(ApplyDiagnosticChoiceToAllSchema) {}

/** One item as Square holds it, on an issue. Prices in cents; null is no price. */
export interface DiagnosticSquareSide {
  itemId: string;
  variationId: string;
  name: string;
  notes: string | null;
  priceCents: number | null;
  version: string | null;
  updatedAt: string | null;
  /** Elsewhere (Plan 48 D11): the copy's SKU, categories and whether it's archived. */
  sku?: string;
  category?: string | null;
  archived?: boolean;
  /** Stock: Square's count in stock. */
  stock?: number;
}

/** One of our items, on an issue. `deleted`: a deleted item with the same SKU. */
export interface DiagnosticOurSide {
  itemId: string;
  name: string;
  notes: string | null;
  priceCents: number | null;
  squareItemId: string | null;
  squareVariationId: string | null;
  sellerName: string | null;
  deleted?: boolean;
  /** Stock: what Square should show (checked in, less sold after refunds), and the two. */
  stock?: number;
  sold?: number;
  checkedIn?: number;
}

export interface DiagnosticIssueResponse {
  id: string;
  sku: string;
  kind: DiagnosticIssueKind;
  field: DiagnosticField | null;
  ours: DiagnosticOurSide | null;
  /** Square's item, or every copy for "twice". */
  square: DiagnosticSquareSide | { copies: DiagnosticSquareSide[] } | null;
  /** "fixed" and "left" are the two ways Mark resolved ends (D5). */
  state: 'open' | 'applied' | 'fixed' | 'left' | 'failed';
  choice: DiagnosticChoice | null;
  decidedByName: string | null;
  decidedAt: string | null;
  error: string | null;
  /** The Square item in the Square Dashboard. */
  squareUrl?: string | null;
  /** Open Sales check sales on this ticket or its Square items: every choice waits for them. */
  heldBySales?: number;
  /**
   * In Square, not in PatrolKit: the item its sale was put on in Sales check
   * (a copy made at the register). Copying it to PatrolKit would be a second
   * item for the same thing, so that choice is refused.
   */
  saleCreditedTo?: { sku: string; name: string } | null;
}

export interface DiagnosticRunResponse {
  id: string;
  /** "interrupted": still marked running ten minutes after its last update (D9). */
  status: 'running' | 'done' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  startedByName: string | null;
  /** Square items read so far. */
  done: number;
  ourCount: number | null;
  squareCount: number | null;
  error: string | null;
  /** Sales check couldn't be read, so what open sales hold back isn't known. */
  salesCheckError?: string | null;
  issues: DiagnosticIssueResponse[];
}

export interface DiagnosticApplyAllResponse {
  applied: number;
  /** Changed since the run: run the checks again to see them as they are. */
  skipped: number;
  failed: number;
  /** Left alone: an open Sales check sale holds them back. */
  held: number;
}
