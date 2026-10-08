/**
 * Items by category's columns (Plan 46 D6), kept apart from the card so they
 * can be tested: each category's total, and how many of its units have sold.
 */

export interface CategoryColumn {
  categoryId: string;
  label: string;
  total: number;
  /** Units sold, never more than the total; null when Square couldn't be read. */
  sold: number | null;
}

export function columns(
  counts: { categoryId: string; label: string; count: number }[],
  sold: { categoryId: string | null; units: number }[] | null,
): CategoryColumn[] {
  const byCategory = sold ? new Map(sold.map((s) => [s.categoryId, s.units])) : null;
  return counts.map((c) => ({
    categoryId: c.categoryId,
    label: c.label,
    total: c.count,
    // A unit sold can be a unit since withdrawn: never draw past the column.
    sold: byCategory ? Math.min(c.count, byCategory.get(c.categoryId) ?? 0) : null,
  }));
}

/** The header's sums: sold and total across the columns shown. */
export function sums(cols: CategoryColumn[]): { total: number; sold: number | null } {
  const total = cols.reduce((n, c) => n + c.total, 0);
  const known = cols.every((c) => c.sold !== null);
  return { total, sold: known ? cols.reduce((n, c) => n + (c.sold ?? 0), 0) : null };
}
