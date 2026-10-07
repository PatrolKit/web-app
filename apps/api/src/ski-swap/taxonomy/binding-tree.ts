import type { TaxonomyKind } from '@prisma/client';

/**
 * Where ski bindings live in the shared tree (Plan 44).
 *
 * Bindings › Type › Skis › Manufacturer is the one question whose values are
 * binding makers, and each maker's Model question is where the indemnified
 * lists are minted. Found by label path rather than by a flag column, because
 * the path is what the seed, the migration and an administrator all agree on.
 */
export const BINDING_MANUFACTURER_PATH = ['Bindings', 'Type', 'Skis', 'Manufacturer'] as const;

/** The Model question each binding maker gets (D1). */
export const BINDING_MODEL_LABEL = 'Model';
export const BINDING_MODEL_NAME_SLOT = 15;

type PathNode = { id: string; parentId: string | null; label: string; kind: TaxonomyKind; orgId: string | null };

/**
 * The id at the end of a label path, among global rows, or null when any step
 * is missing. Pure: give it the nodes.
 */
export function findByPath(nodes: PathNode[], path: readonly string[]): PathNode | null {
  let parentId: string | null = null;
  let found: PathNode | null = null;
  for (const label of path) {
    const want = label.trim().toLowerCase();
    found =
      nodes.find((n) => n.orgId === null && n.parentId === parentId && n.label.trim().toLowerCase() === want) ??
      null;
    if (!found) return null;
    parentId = found.id;
  }
  return found;
}
