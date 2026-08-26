// Shared setup for the smoke scripts.
//
// They run against whatever database is in front of them, including a freshly
// seeded production one that has nothing in it but permissions, modules, and a
// super admin. So they bring their own org rather than assuming a demo org
// exists, and take it away again on the way out.

import { createId } from '@paralleldrive/cuid2';

const SMOKE_SLUG = 'patrolkit-smoke';

/**
 * An org the smoke scripts own outright, with ski-swap enabled.
 *
 * Reused across runs when it survives a crash, so a failed script does not
 * leave a trail of orgs behind it.
 */
export async function smokeOrg(prisma) {
  const existing = await prisma.organization.findUnique({ where: { slug: SMOKE_SLUG } });
  const org = existing ?? await prisma.organization.create({
    data: { id: createId(), name: 'PatrolKit smoke tests', slug: SMOKE_SLUG },
  });

  await prisma.orgModule.upsert({
    where: { orgId_moduleKey: { orgId: org.id, moduleKey: 'ski_swap' } },
    update: { enabled: true },
    create: {
      id: createId(),
      orgId: org.id,
      moduleKey: 'ski_swap',
      enabled: true,
      enabledAt: new Date(),
    },
  });

  return org;
}

/**
 * A member of the smoke org holding every ski-swap permission, so scripts that
 * need a staff session have someone to be.
 */
export async function smokeStaff(prisma, org, permissions) {
  // `email` is not unique — only a *verified* claim is (that is the identity
  // model), so this is find-then-create rather than an upsert.
  const email = 'smoke-staff@patrolkit.invalid';
  const user = await prisma.user.findFirst({ where: { email } })
    ?? await prisma.user.create({
      data: { id: createId(), email, firstName: 'Smoke', lastName: 'Staff' },
    });

  const membership = await prisma.membership.upsert({
    where: { userId_orgId: { userId: user.id, orgId: org.id } },
    update: { deletedAt: null },
    create: { id: createId(), userId: user.id, orgId: org.id, updatedAt: new Date() },
  });

  const rows = await prisma.permission.findMany({ where: { key: { in: permissions } } });
  for (const permission of rows) {
    await prisma.membershipPermission.upsert({
      where: { membershipId_permissionId: { membershipId: membership.id, permissionId: permission.id } },
      update: {},
      create: { membershipId: membership.id, permissionId: permission.id },
    });
  }

  return { user, membership };
}

/** Cascades take everything the scripts made with it. */
export async function dropSmokeOrg(prisma) {
  const org = await prisma.organization.findUnique({ where: { slug: SMOKE_SLUG } });
  if (!org) return;
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: 'smoke-staff@patrolkit.invalid' } });
}

import { createHash } from 'crypto';

/** The code these scripts confirm with, once they have set the hash themselves. */
export const SMOKE_CODE = 'smoke-code-000000';

/**
 * Rewrites a live challenge to a code we know, so a script can complete a
 * sign-in without receiving the message.
 *
 * Production deliberately withholds `devCode` — a reachable host that hands back
 * sign-in codes is an authentication bypass — so a script cannot read one from
 * the API. It can, however, write to the database, which is a strictly higher
 * privilege than any API call. Only the delivery step is bypassed; the confirm
 * endpoint, the session, and the stamping are all the real thing.
 */
export async function forceChallengeCode(prisma, challengeId) {
  await prisma.contactChallenge.update({
    where: { id: challengeId },
    data: { codeHash: createHash('sha256').update(SMOKE_CODE).digest('hex'), attempts: 0 },
  });
  return SMOKE_CODE;
}

/** Signs a user in over HTTP, bypassing only the delivery of the code. */
export async function smokeSession(prisma, base, user, unwrap) {
  const start = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email }),
  }).then(unwrap);

  const code = await forceChallengeCode(prisma, start.challengeId);
  const session = await fetch(`${base}/auth/challenges/${start.challengeId}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  }).then(unwrap);

  return session.accessToken;
}
