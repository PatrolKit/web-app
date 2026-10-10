/**
 * The swap diagnostics' issues and choices (Plan 41), with no dependencies so
 * the web can import them as values: the server checks a choice against
 * these, and the popover offers the same ones.
 */

export const DIAGNOSTIC_ISSUE_KINDS = ['only_square', 'only_ours', 'differs', 'not_linked', 'twice', 'returned', 'elsewhere', 'stock'] as const;
export type DiagnosticIssueKind = (typeof DIAGNOSTIC_ISSUE_KINDS)[number];

export const DIAGNOSTIC_FIELDS = ['name', 'notes', 'price'] as const;
export type DiagnosticField = (typeof DIAGNOSTIC_FIELDS)[number];

export const DIAGNOSTIC_CHOICES = [
  'copy_to_patrolkit', 'copy_to_square', 'use_square', 'use_ours', 'link', 'keep', 'remove_from_square',
  'delete_other', 'renumber_other', 'resolve', 'set_price', 'set_stock',
] as const;
export type DiagnosticChoice = (typeof DIAGNOSTIC_CHOICES)[number];

/** The choices each kind of issue offers (D3). Mark resolved is everywhere. */
export const CHOICES_FOR: Record<DiagnosticIssueKind, readonly DiagnosticChoice[]> = {
  only_square: ['copy_to_patrolkit', 'resolve'],
  only_ours: ['copy_to_square', 'resolve'],
  // Set a new price: Price differs only, one item at a time, to both sides.
  differs: ['use_square', 'use_ours', 'set_price', 'resolve'],
  not_linked: ['link', 'resolve'],
  twice: ['keep', 'resolve'],
  // Returned to its seller and still in Square (Plan 43 D9): its delete failed.
  returned: ['remove_from_square', 'resolve'],
  // Another Square item has the same SKU, outside the category or archived
  // (Plan 48 D11). Square still scans archived items, so the register can
  // ring the sale up on it.
  elsewhere: ['delete_other', 'renumber_other', 'resolve'],
  // Square's stock isn't what the item's sales leave (Plan 48): set it to that.
  stock: ['set_stock', 'resolve'],
};
