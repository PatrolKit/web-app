import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * Comps (Plan 53): an item marked sold with no Square sale behind it, so its
 * seller is paid the list price. Staff only; customers just see "Sold".
 */

export const COMP_REASONS = ['OUTSIDE', 'NOT_FOUND', 'LOST', 'OTHER'] as const;
export type CompReason = (typeof COMP_REASONS)[number];

export const CreateCompSchema = z
  .object({
    reason: z.enum(COMP_REASONS),
    note: z.string().trim().min(1, 'Say why, for the record.').max(2000),
    /** Only for an unpriced item, which takes it as its list price first (D4). */
    priceCents: z.number().int().positive().max(10_000_000).optional(),
    /** Units to comp; one, unless the item has more than one unsold. */
    units: z.number().int().min(1).max(100).default(1),
  })
  .strict();
export class CreateCompDto extends createZodDto(CreateCompSchema) {}

export const UndoCompSchema = z.object({ note: z.string().trim().min(1, 'Say why, for the record.').max(2000) }).strict();
export class UndoCompDto extends createZodDto(UndoCompSchema) {}

/** A live comp, as a staff item response carries it (D6). */
export interface ItemComp {
  id: string;
  priceCents: number;
  units: number;
  reason: CompReason;
  note: string;
  compedAt: string;
  compedBy: string | null;
}

/** One comp on Adjustments → Comps (D10), live or undone. */
export interface CompView extends ItemComp {
  item: { id: string; sku: string; name: string; deleted: boolean };
  seller: { id: string; name: string } | null;
  compedByName: string | null;
  undone: { at: string; by: string | null; byName: string | null; note: string | null } | null;
  /** In a payout line whose money moved: undo is refused (D7). */
  paid: boolean;
}

export interface CompsResponse {
  comps: CompView[];
  /** Live comps: how many units, and what sellers are owed on them before the patrol's share. */
  live: { count: number; totalCents: number };
}
