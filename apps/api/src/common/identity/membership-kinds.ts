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

/**
 * The members a list of people shows: everyone `IS_MEMBER`, except super admins
 * (iPad Plan 42). A super admin's way into an org is the flag on their user, not
 * the membership; a membership they hold, from creating the org say, would
 * otherwise put the platform's operator on Members and the clock-in roster.
 *
 * Only lists read this. Sign-in and the account's own org list keep `IS_MEMBER`,
 * so a super admin still reaches the orgs they belong to, and their permissions
 * stay, taking effect again if the flag is ever cleared.
 *
 * Nothing in the app sets the flag. Whoever flips it by hand must bump the
 * user's memberships' `updatedAt`, so iPads hear of it on their next delta.
 */
export const IS_LISTED_MEMBER: Prisma.MembershipWhereInput = {
  AND: [IS_MEMBER, { user: { isSuperAdmin: false } }],
};
