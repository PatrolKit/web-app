import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * The code a member clocks in with (Plan 57 D7, D8): their NSP ID if they have
 * one, otherwise a 6-digit PIN they chose. Clocking out finds the person by the
 * code alone, so within an org no two members may share one, whether PIN or NSP
 * ID. NSP IDs are already unique everywhere; PINs are checked against both.
 */

export const PIN_PATTERN = /^\d{6}$/;

type Db = Pick<Prisma.TransactionClient, 'patrollerProfile' | 'user'>;

/** Throws unless `pin` is six digits and nobody else in the org clocks in with it. */
export async function assertPinAvailable(db: Db, orgId: string, pin: string, selfMembershipId: string): Promise<void> {
  if (!PIN_PATTERN.test(pin)) throw new BadRequestException('A PIN is six digits.');
  const [pinHolder, nspHolder] = await Promise.all([
    db.patrollerProfile.findFirst({
      where: { clockPin: pin, membershipId: { not: selfMembershipId }, membership: { orgId, deletedAt: null } },
      select: { id: true },
    }),
    db.user.findFirst({
      where: { nspId: pin, memberships: { some: { orgId, deletedAt: null } } },
      select: { id: true },
    }),
  ]);
  // Never says whose: a PIN someone else holds is not this person's to learn.
  if (pinHolder || nspHolder) throw new BadRequestException('That PIN is taken. Choose another.');
}

/**
 * A member given an NSP ID that equals someone's PIN takes it: the PIN is cleared,
 * and its holder is asked for a new one on My account (D8). Returns how many.
 */
export async function clearPinsMatching(db: Db, orgIds: string[], nspId: string): Promise<number> {
  if (!PIN_PATTERN.test(nspId) || !orgIds.length) return 0;
  const { count } = await db.patrollerProfile.updateMany({
    where: { clockPin: nspId, membership: { orgId: { in: orgIds } } },
    data: { clockPin: null },
  });
  return count;
}
