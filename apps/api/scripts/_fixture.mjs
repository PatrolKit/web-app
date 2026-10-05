// Shared setup for the smoke scripts.
//
// These create and delete rows in whatever database SMOKE_BASE points at. Run
// against production they are one scoping mistake away from taking real data
// with them, so every fixture lives in an org of its own and cleanup deletes by
// id. Prefer a local database; reach for production only to prove a deploy, and
// check what survived afterwards.
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

  // Set, not add. Every script shares this user, so a purely additive grant
  // means whichever ran last leaves its permissions behind — and a script then
  // passes on authority it never asked for. That is a green that means nothing,
  // and it hid two real failures until production ran the scripts in a
  // different order.
  const rows = await prisma.permission.findMany({ where: { key: { in: permissions } } });
  const before = await prisma.membershipPermission.findMany({
    where: { membershipId: membership.id },
    select: { permissionId: true },
  });
  await prisma.membershipPermission.deleteMany({
    where: { membershipId: membership.id, permissionId: { notIn: rows.map((r) => r.id) } },
  });
  for (const permission of rows) {
    await prisma.membershipPermission.upsert({
      where: { membershipId_permissionId: { membershipId: membership.id, permissionId: permission.id } },
      update: {},
      create: { membershipId: membership.id, permissionId: permission.id },
    });
  }

  // The server caches a membership's permissions for five seconds
  // (`PermissionsService`), and these scripts write straight to the database,
  // so nothing tells it to look again. A script that narrows the set and then
  // acts on it within that window is refused with the *previous* script's
  // authority — a 403 that looks like a bug in whatever it was calling.
  //
  // Waited only when the set actually changed, so a run of scripts asking for
  // the same permissions pays nothing. This is the price of sharing one user
  // across every script; the alternative is a user per script and a slower,
  // less honest fixture.
  const changed =
    before.length !== rows.length ||
    new Set(before.map((b) => b.permissionId)).size !== new Set(rows.map((r) => r.id)).size ||
    rows.some((r) => !before.some((b) => b.permissionId === r.id));
  if (changed) await new Promise((r) => setTimeout(r, 5_100));

  return { user, membership };
}

/**
 * A super admin, for scripts that read Platform Admin — the Server health page.
 *
 * Its own user rather than a flag on the shared staff user: every script signs
 * that one in, and a super admin behind all of them would pass permission
 * checks nothing was meant to pass. Deleted by `dropSmokeAdmin`, and by
 * `dropSmokeOrg`.
 */
export async function smokeSuperAdmin(prisma) {
  const email = 'smoke-admin@patrolkit.invalid';
  return await prisma.user.findFirst({ where: { email } })
    ?? await prisma.user.create({
      data: { id: createId(), email, firstName: 'Smoke', lastName: 'Admin', isSuperAdmin: true },
    });
}

export async function dropSmokeAdmin(prisma) {
  await prisma.user.deleteMany({ where: { email: 'smoke-admin@patrolkit.invalid' } });
}

/** Cascades take everything the scripts made with it. */
export async function dropSmokeOrg(prisma) {
  const org = await prisma.organization.findUnique({ where: { slug: SMOKE_SLUG } });
  if (!org) return;
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { email: 'smoke-staff@patrolkit.invalid' } });
  await dropSmokeAdmin(prisma);
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
  // Over a limit the start call answers an error rather than a challenge, and
  // the id arrives here as undefined — which used to surface as a Prisma
  // validation dump about `ContactChallengeWhereUniqueInput`, several screens
  // long, naming nothing a reader could act on.
  if (!challengeId) {
    throw new Error(
      'No challenge to confirm. The sign-in was almost certainly refused by a ' +
        'limit — see the response above, and Plan 26.',
    );
  }
  // A sign-in over the per-destination limit answers with a decoy: an id that
  // was never stored. `update` would fail on it with a Prisma error naming a
  // missing record; say what it actually means instead.
  const exists = await prisma.contactChallenge.findUnique({ where: { id: challengeId }, select: { id: true } });
  if (!exists) {
    throw new Error(
      'That challenge was never stored — the sign-in was answered with a decoy, ' +
        'which is what a destination over its code limit gets. Clear its codes ' +
        'with forgetSentCodes() first.',
    );
  }
  await prisma.contactChallenge.update({
    where: { id: challengeId },
    data: { codeHash: createHash('sha256').update(SMOKE_CODE).digest('hex'), attempts: 0 },
  });
  return SMOKE_CODE;
}

/**
 * Forgets every code sent to a destination, so a script that signs the same
 * person in on every run does not meet the limit of five in 15 minutes.
 *
 * Only the smoke scripts do this, and only because they can write to the
 * database — a strictly higher privilege than anything the API offers.
 */
export async function forgetSentCodes(prisma, target) {
  await prisma.contactChallenge.deleteMany({ where: { target } });
}

/** Signs a user in over HTTP, bypassing only the delivery of the code. */
export async function smokeSession(prisma, base, user, unwrap) {
  await forgetSentCodes(prisma, user.email);
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

/**
 * Turns texting on or off platform-wide (Plan 29), through the API so its
 * cache sees the change, and returns what it was so a script can put it back.
 *
 * Scripts that sign sellers up by phone turn it on for their run. On a server
 * with no origination number nothing is actually sent either way: codes are
 * read back with `forceChallengeCode`.
 */
export async function setTexting(prisma, base, unwrap, on) {
  const admin = await smokeSuperAdmin(prisma);
  const token = await smokeSession(prisma, base, admin, unwrap);
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const before = await fetch(`${base}/admin/settings`, { headers: H }).then(unwrap);
  await fetch(`${base}/admin/settings`, { method: 'PATCH', headers: H, body: JSON.stringify({ smsEnabled: on }) });
  await dropSmokeAdmin(prisma);
  return before.smsEnabled;
}

/**
 * Turns texting on for the rest of a script's run, and returns what puts it
 * back. A script that crashes part-way puts it back too: otherwise one failure
 * leaves a server offering texts nobody meant it to.
 */
export async function textingOnForRun(prisma, base, unwrap) {
  const was = await setTexting(prisma, base, unwrap, true);
  const restore = () => setTexting(prisma, base, unwrap, was);
  process.once('uncaughtException', async (err) => {
    console.error(err);
    try { await restore(); } finally { process.exit(1); }
  });
  return restore;
}

/**
 * Issues a block of tickets to a seller the way the service does (Plan 38):
 * one accepted, unpriced item per number, its tag already on the goods. For
 * a smoke that needs a shop holding tickets but isn't testing the issuing.
 */
export async function issueTickets(prisma, { orgId, swapId, sellerId, startNumber, endNumber }) {
  const { randomUUID } = await import('crypto');
  const now = new Date();
  const data = [];
  for (let n = startNumber; n <= endNumber; n++) {
    const sku = String(n);
    data.push({
      id: randomUUID(), orgId, swapId, sellerId, sku, liveSku: sku, name: `Item #${sku}`,
      priceCents: null, originalQuantity: 1, hasPrintedTag: true, consignedAt: now,
    });
  }
  await prisma.swapItem.createMany({ data });
}
