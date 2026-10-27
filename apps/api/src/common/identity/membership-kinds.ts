import type { Prisma } from '@prisma/client';

/**
 * Who counts as a member of an org: anyone with a member record, or anyone
 * given permissions (Plan 57 D2). A ski swap seller has a membership too,
 * because that's where a seller profile hangs, but someone who is only a seller
 * isn't a member and is managed under Ski Swap > Sellers.
 *
 * The record decides, not the absence of a seller profile: a member who later
 * sells at the swap is still a member. Every way of becoming one creates the
 * record (`PersonService.ensureMemberRecord`); permissions count on their own
 * so that a grant made before the record exists still makes a member.
 *
 * The Members page lists these, the sign-in policy lets them in (Plan 33), and
 * the time clock's roster is them (Plan 57 D1), so all three read from this.
 */
export const IS_MEMBER: Prisma.MembershipWhereInput = {
  OR: [
    { patrollerProfile: { is: { deletedAt: null } } },
    { permissions: { some: {} } },
  ],
};
