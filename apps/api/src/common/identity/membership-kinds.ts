import type { Prisma } from '@prisma/client';

/**
 * Who counts as a member of an org: patrollers, anyone given permissions, and
 * anyone invited here plainly. A ski swap seller has a membership too, because
 * that's where a seller profile hangs, but someone who is only a seller isn't a
 * member and is managed under Ski Swap > Sellers.
 *
 * The Members page lists these, and the sign-in policy lets them in (Plan 33),
 * so the two read from the one definition.
 */
export const IS_MEMBER: Prisma.MembershipWhereInput = {
  OR: [
    { sellerProfile: { is: null } },
    { sellerProfile: { is: { deletedAt: { not: null } } } },
    { patrollerProfile: { is: { deletedAt: null } } },
    { permissions: { some: {} } },
  ],
};
