/**
 * The two label normalisers the tree keys on, kept free of Nest so a seed or
 * an import script can share them with the service.
 */

/** The scope half of a dedupe key. Global rows have no org to name. */
function scopeKey(orgId: string | null): string {
  return orgId ?? 'global';
}

/**
 * `<scope>:<parent>:<label>`, the one column that actually prevents duplicates.
 *
 * MySQL treats NULLs in a unique index as distinct, and both `orgId` and
 * `parentId` are nullable — a composite unique over them would let two global
 * categories called "Skis" through. Normalising the label here is also what
 * makes "Rossignol" and "rossignol  " the same pending value rather than two.
 */
export function dedupeKeyFor(orgId: string | null, parentId: string | null, label: string): string {
  return `${scopeKey(orgId)}:${parentId ?? 'root'}:${normalizeLabel(label)}`;
}

/** The label half alone, for comparing two nodes that already share a parent. */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}
