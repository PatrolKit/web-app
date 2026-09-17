import { Prisma } from '@prisma/client';

/**
 * A row somebody else inserted first.
 *
 * `upsert` on a unique key is a select and then an insert, not one atomic
 * statement, so two callers racing to create the same row both miss and both
 * insert — and the loser comes back with P2002 on the constraint that was
 * supposed to make the operation safe. For an idempotent create the loser has
 * still got what it asked for: the row exists. Catch this, read it back, and
 * carry on.
 *
 * Only for upserts whose `create` is genuinely idempotent. A real duplicate —
 * a second club claiming a taken slug — is the same error code and must still
 * reach the caller, so the decision to swallow it belongs at the call site.
 */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
