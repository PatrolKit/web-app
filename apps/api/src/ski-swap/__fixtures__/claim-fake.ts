/**
 * The Square-create claim (Plan 47) against a test's in-memory rows: what
 * MySQL does for `claimForSquareCreate` and `releaseSquareCreateClaim`, so a
 * hand-rolled Prisma fake can pass its claim calls here.
 */
type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

/** Whether this `updateMany` or `findMany` is a claim's, rather than the test's own. */
export function isClaimCall(where: Where | undefined, data?: Record<string, unknown>): boolean {
  return !!where && ('squareCreateClaim' in where || (!!data && 'squareCreateClaim' in data));
}

/** Applies a claim or a release to the rows, as the database would. */
export function claimUpdate(rows: Row[], where: Where, data: Record<string, unknown>): { count: number } {
  // A release: by token.
  if (typeof where.squareCreateClaim === 'string') {
    const held = rows.filter((r) => r.squareCreateClaim === where.squareCreateClaim);
    for (const r of held) Object.assign(r, data);
    return { count: held.length };
  }
  // A claim: no Square id, live, and no live claim.
  const ids = (where.id as { in: string[] }).in;
  const cutoff = Date.now() - 2 * 60 * 1000;
  const free = rows.filter((r) => ids.includes(r.id) && !r.squareItemId && !r.deletedAt
    && (!r.squareCreateClaim || (r.squareCreateClaimedAt instanceof Date && r.squareCreateClaimedAt.getTime() < cutoff)));
  for (const r of free) Object.assign(r, data);
  return { count: free.length };
}

/** A claim's read-back: the rows holding its token. */
export function claimRead(rows: Row[], where: Where): { id: string }[] {
  const ids = (where.id as { in: string[] } | undefined)?.in;
  return rows.filter((r) => r.squareCreateClaim === where.squareCreateClaim && (!ids || ids.includes(r.id))).map((r) => ({ id: r.id }));
}
