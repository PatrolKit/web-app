/**
 * A place in a keyset walk: the `(updatedAt, id)` of the last row handed out.
 *
 * Base64 rather than the two values in the open, so a client treats it as a
 * bookmark it received rather than as two fields it may compose. What it is
 * made of is ours to change; that it round-trips is the contract.
 */
export function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    // The first separator, not every one. An id containing a `|` would
    // otherwise come back truncated, and seek to a different row than the one
    // the walk stopped at — quietly, since a shorter id is still a valid id.
    const at = raw.indexOf('|');
    if (at < 0) return null;
    const updatedAt = new Date(raw.slice(0, at));
    const id = raw.slice(at + 1);
    if (!id || Number.isNaN(updatedAt.getTime())) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

/**
 * The `where` that seeks past a cursor in `(updatedAt, id)` order: rows changed later, or
 * changed in the same millisecond with a later id. `id` breaks the tie, because
 * `updatedAt` is not unique and a cursor on it alone would repeat or skip rows.
 */
export function afterCursor(after: { updatedAt: Date; id: string }) {
  return {
    OR: [
      { updatedAt: { gt: after.updatedAt } },
      { updatedAt: after.updatedAt, id: { gt: after.id } },
    ],
  };
}
