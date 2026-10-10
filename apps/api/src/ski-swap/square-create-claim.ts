import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';

/**
 * Claiming items before creating them in Square (Plan 47).
 *
 * Three paths create Square items: an item's own sync, the issued-ticket push
 * and a file import. Creating one takes about a second, and until it's done
 * the item has no `squareItemId`. A second path that looked in that second
 * saw an item still to create and created its own, leaving an orphan that the
 * register offered beside the real one (2026-10-09, tickets 74819–74822).
 *
 * Asking Square first can't close that gap: while the first create is in
 * flight, Square doesn't have the item yet. So a path claims the items in our
 * own database first, in one statement, and creates only the ones it got.
 * MySQL serialises two such updates on a row, so exactly one wins.
 */

/** A claim older than this was abandoned (a crash mid-create) and may be taken over. */
export const SQUARE_CREATE_CLAIM_TTL_MS = 2 * 60 * 1000;

/** Spread into the write that stores an item's Square ids: the create is done. */
export const CLAIM_RELEASED = { squareCreateClaim: null, squareCreateClaimedAt: null } as const;

/** Not held by a live claim: none at all, or one old enough to be abandoned. */
export function unclaimedWhere(now = new Date()): Prisma.SwapItemWhereInput {
  return {
    OR: [
      { squareCreateClaim: null },
      { squareCreateClaimedAt: { lt: new Date(now.getTime() - SQUARE_CREATE_CLAIM_TTL_MS) } },
    ],
  };
}

interface ClaimDb {
  swapItem: {
    updateMany(args: { where: Prisma.SwapItemWhereInput; data: Prisma.SwapItemUpdateManyMutationInput }): Promise<{ count: number }>;
    findMany(args: { where: Prisma.SwapItemWhereInput; select: { id: true } }): Promise<{ id: string }[]>;
  };
}

export interface SquareCreateClaim {
  token: string;
  /** The items this caller may create: the others are someone else's, or already in Square. */
  ids: string[];
}

/**
 * Claims these items for creating in Square: those with no Square id and no
 * live claim. Returns which ones this caller got.
 */
export async function claimForSquareCreate(db: ClaimDb, itemIds: string[]): Promise<SquareCreateClaim> {
  const token = randomUUID();
  if (itemIds.length === 0) return { token, ids: [] };
  const now = new Date();
  await db.swapItem.updateMany({
    // A withdrawn item has nothing to create.
    where: { id: { in: itemIds }, deletedAt: null, squareItemId: null, ...unclaimedWhere(now) },
    data: { squareCreateClaim: token, squareCreateClaimedAt: now },
  });
  const held = await db.swapItem.findMany({ where: { id: { in: itemIds }, deletedAt: null, squareCreateClaim: token }, select: { id: true } });
  return { token, ids: held.map((r) => r.id) };
}

/** Gives up whatever of this claim is still held: a create that failed, or one never attempted. */
export async function releaseSquareCreateClaim(db: ClaimDb, claim: SquareCreateClaim): Promise<void> {
  if (claim.ids.length === 0) return;
  await db.swapItem.updateMany({ where: { squareCreateClaim: claim.token }, data: { ...CLAIM_RELEASED } });
}
