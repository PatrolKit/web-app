import type { CompReason } from '../../../lib/api.types';

/** Comps (Plan 53): the reasons, in words. */
export const COMP_REASONS: { value: CompReason; label: string; hint: string }[] = [
  { value: 'OUTSIDE', label: 'Paid outside Square', hint: 'Cash or a check the register never saw.' },
  { value: 'NOT_FOUND', label: 'Sold, no sale found', hint: 'It left with a buyer, and the sale can’t be found in Square.' },
  { value: 'LOST', label: 'Lost or damaged', hint: 'The patrol makes good on it.' },
  { value: 'OTHER', label: 'Other', hint: 'Say what happened in the note.' },
];

export const compReasonLabel = (r: CompReason) => COMP_REASONS.find((x) => x.value === r)?.label ?? r;

/** What the seller is paid on a comp: the list price, less the patrol's share (rounded once). */
export function sellerGets(priceCents: number, units: number, commissionBasisPoints: number): number {
  const gross = priceCents * units;
  return gross - Math.round((gross * commissionBasisPoints) / 10_000);
}
