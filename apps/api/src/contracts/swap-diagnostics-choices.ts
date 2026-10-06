/**
 * The swap diagnostics' issues and choices (Plan 41), with no dependencies so
 * the web can import them as values: the server checks a choice against
 * these, and the popover offers the same ones.
 */

export const DIAGNOSTIC_ISSUE_KINDS = ['only_square', 'only_ours', 'differs', 'not_linked', 'twice'] as const;
export type DiagnosticIssueKind = (typeof DIAGNOSTIC_ISSUE_KINDS)[number];

export const DIAGNOSTIC_FIELDS = ['name', 'notes', 'price'] as const;
export type DiagnosticField = (typeof DIAGNOSTIC_FIELDS)[number];

export const DIAGNOSTIC_CHOICES = [
  'copy_to_patrolkit', 'copy_to_square', 'use_square', 'use_ours', 'link', 'keep', 'resolve',
] as const;
export type DiagnosticChoice = (typeof DIAGNOSTIC_CHOICES)[number];

/** The choices each kind of issue offers (D3). Mark resolved is everywhere. */
export const CHOICES_FOR: Record<DiagnosticIssueKind, readonly DiagnosticChoice[]> = {
  only_square: ['copy_to_patrolkit', 'resolve'],
  only_ours: ['copy_to_square', 'resolve'],
  differs: ['use_square', 'use_ours', 'resolve'],
  not_linked: ['link', 'resolve'],
  twice: ['keep', 'resolve'],
};
