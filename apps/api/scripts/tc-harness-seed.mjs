// Seeds a run of the iPad's time clock scenario harness (iOS Plan 43), and takes it away
// again. Prints one JSON object on stdout for the harness; everything else goes to stderr.
//
//   node apps/api/scripts/tc-harness-seed.mjs                      a run in a fresh local org
//   node apps/api/scripts/tc-harness-seed.mjs --cleanup <runId>    removes that run
//
// Against production it runs on the server, like the smokes (systemd-run as patrolkit),
// with --test-org, and only ever inside the org with the slug below, which a super admin
// creates by hand. It never creates or deletes that org; a run adds its own resorts,
// iPads, patrollers and staff account, all named for the run, and cleanup removes those.
//
//   SMOKE_BASE=https://patrolkit.io/api/v1 node tc-harness-seed.mjs --test-org
//   SMOKE_BASE=https://patrolkit.io/api/v1 node tc-harness-seed.mjs --test-org --cleanup <runId>
//
// Without --test-org it refuses any database that isn't on this machine.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { randomInt } from 'crypto';

import { forceChallengeCode, forgetSentCodes } from './_fixture.mjs';

const TEST_ORG_SLUG = 'patrolkit-time-clock-tests';
const LOCAL_SLUG_PREFIX = 'tc-harness-';

const args = process.argv.slice(2);
const testOrg = args.includes('--test-org');
const cleanupAt = args.indexOf('--cleanup');
const cleanupRun = cleanupAt >= 0 ? args[cleanupAt + 1] : null;
if (cleanupAt >= 0 && !/^[a-z0-9]{6,12}$/.test(cleanupRun ?? '')) fail('--cleanup needs the runId a seed printed.');

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const log = (...m) => console.error(...m);
function fail(message) {
  console.error(`tc-harness-seed: ${message}`);
  process.exit(1);
}

// ─── Where it may run ────────────────────────────────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const dbHost = (() => {
  try { return new URL(process.env.DATABASE_URL ?? '').hostname; } catch { return ''; }
})();
const local = LOOPBACK.has(dbHost);
if (!testOrg && !local) fail(`the database at "${dbHost || '(none)'}" isn't local. Only --test-org runs against another.`);
if (!testOrg && !LOOPBACK.has(new URL(BASE).hostname)) fail(`a local run calls a local API, not ${BASE}.`);

const prisma = new PrismaClient();
const unwrap = async (r) => {
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${r.status} ${r.url}: ${JSON.stringify(b)}`);
  return b && b.success && 'data' in b ? b.data : b;
};

const tag = (runId) => `TC ${runId}`;
const mail = (runId, who) => `tc-${runId}-${who}@patrolkit.invalid`;

/** The org a run lives in: the test org itself, or the fresh local org it made. */
async function orgOf(runId) {
  const slug = testOrg ? TEST_ORG_SLUG : `${LOCAL_SLUG_PREFIX}${runId}`;
  return prisma.organization.findUnique({ where: { slug } });
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

async function cleanup(runId) {
  const org = await orgOf(runId);
  const users = await prisma.user.findMany({
    where: { email: { startsWith: `tc-${runId}-`, endsWith: '@patrolkit.invalid' } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  if (org) {
    const profiles = await prisma.patrollerProfile.findMany({
      where: { membership: { orgId: org.id, userId: { in: userIds } } },
      select: { id: true },
    });
    const ids = profiles.map((p) => p.id);
    const resorts = await prisma.resort.findMany({ where: { orgId: org.id, name: { startsWith: tag(runId) } }, select: { id: true } });
    const resortIds = resorts.map((r) => r.id);
    // A scenario's events can only name the run's patrollers and resorts.
    await prisma.timeClockEvent.deleteMany({ where: { orgId: org.id, OR: [{ patrollerId: { in: ids } }, { resortId: { in: resortIds } }] } });
    await prisma.timeEntry.deleteMany({ where: { orgId: org.id, OR: [{ patrollerId: { in: ids } }, { resortId: { in: resortIds } }] } });
    await prisma.patrollerProfile.deleteMany({ where: { id: { in: ids } } });
    await prisma.membership.deleteMany({ where: { orgId: org.id, userId: { in: userIds } } });
    await prisma.device.deleteMany({ where: { orgId: org.id, name: { startsWith: tag(runId) } } });
    await prisma.resort.deleteMany({ where: { id: { in: resortIds } } });
    // A local run's org is the run's own; the test org stays.
    if (!testOrg && org.slug === `${LOCAL_SLUG_PREFIX}${runId}`) await prisma.organization.delete({ where: { id: org.id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  log(`removed run ${runId}${org ? ` from ${org.slug}` : ''}: ${userIds.length} people`);
}

if (cleanupRun) {
  await cleanup(cleanupRun);
  await prisma.$disconnect();
  process.exit(0);
}

// ─── Seed ────────────────────────────────────────────────────────────────────

const runId = createId().slice(0, 10);

let org;
if (testOrg) {
  org = await orgOf(runId);
  if (!org) fail(`there is no org "${TEST_ORG_SLUG}". A super admin creates it first.`);
} else {
  org = await prisma.organization.create({
    data: { id: createId(), name: `Time clock harness ${runId}`, slug: `${LOCAL_SLUG_PREFIX}${runId}` },
  });
}
await prisma.orgModule.upsert({
  where: { orgId_moduleKey: { orgId: org.id, moduleKey: 'time_tracking' } },
  update: { enabled: true },
  create: { id: createId(), orgId: org.id, moduleKey: 'time_tracking', enabled: true, enabledAt: new Date() },
});

// What seeding needs, then what the harness keeps (iOS Plan 43 §3).
const SEEDING = ['org:manage', 'users:invite'];
const HARNESS = ['time_tracking:report', 'time_tracking:manage', 'time_tracking:admin', 'users:read', 'users:manage'];

async function grant(membershipId, keys) {
  const rows = await prisma.permission.findMany({ where: { key: { in: keys } } });
  await prisma.membershipPermission.deleteMany({ where: { membershipId, permissionId: { notIn: rows.map((r) => r.id) } } });
  for (const p of rows) {
    await prisma.membershipPermission.upsert({
      where: { membershipId_permissionId: { membershipId, permissionId: p.id } },
      update: {},
      create: { membershipId, permissionId: p.id },
    });
  }
}

/** Signs in over HTTP, bypassing only the code's delivery, and keeps the refresh cookie. */
async function signIn(user) {
  await forgetSentCodes(prisma, user.email);
  const start = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email }),
  }).then(unwrap);
  const code = await forceChallengeCode(prisma, start.challengeId);
  const r = await fetch(`${BASE}/auth/challenges/${start.challengeId}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('refresh_token='));
  const session = await unwrap(r);
  return { accessToken: session.accessToken, refreshToken: cookie ? decodeURIComponent(cookie.split(';')[0].slice('refresh_token='.length)) : null };
}

try {
  const staffUser = await prisma.user.create({
    data: { id: createId(), email: mail(runId, 'staff'), firstName: 'Harness', lastName: `Staff ${runId}` },
  });
  const staffMembership = await prisma.membership.create({
    data: { id: createId(), userId: staffUser.id, orgId: org.id, updatedAt: new Date() },
  });
  await grant(staffMembership.id, [...SEEDING, ...HARNESS]);
  const session = await signIn(staffUser);
  const H = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' };
  const api = (path, body) =>
    fetch(`${BASE}/orgs/${org.id}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }).then(unwrap);

  const resort = (name, timeZone) =>
    prisma.resort.create({ data: { id: createId(), orgId: org.id, name: `${tag(runId)} ${name}`, timeZone, updatedAt: new Date() } });
  const lodge = await resort('Lodge', 'America/New_York');
  const summit = await resort('Summit', 'America/Denver');

  const devices = [];
  for (const [name, r] of [['Lodge 1', lodge], ['Lodge 2', lodge], ['Summit 1', summit], ['Summit 2', summit]]) {
    const d = await api('/devices', { name: `${tag(runId)} ${name}`, role: 'org.tablet', resortId: r.id });
    devices.push({ id: d.id, name: d.name, resortId: r.id, clientId: d.clientId, clientSecret: d.clientSecret });
  }

  // Patrollers are members (Plan 57), added as Members adds them.
  const NSP = runId.toUpperCase();
  async function member(first, nspId) {
    const m = await api('/members', {
      firstName: first, lastName: `Harness ${runId}`, email: mail(runId, first.toLowerCase()),
      ...(nspId ? { nspId } : {}), patrolLevel: 'Basic', permissions: [],
    });
    const record = await prisma.patrollerProfile.upsert({
      where: { membershipId: m.membershipId },
      update: {},
      create: { id: createId(), membershipId: m.membershipId },
    });
    return { id: record.id, userId: m.userId, membershipId: m.membershipId, name: first, nspId: nspId ?? null, pin: null };
  }
  const ann = await member('Ann', `TCA${NSP}`);
  const ben = await member('Ben', `TCB${NSP}`);
  const cy = await member('Cy', null);

  // Cy chooses a PIN as My account would: unique in the org, never anyone's NSP ID there.
  let pin;
  do {
    pin = String(randomInt(100000, 1000000));
  } while (
    (await prisma.patrollerProfile.count({ where: { clockPin: pin, membership: { orgId: org.id, deletedAt: null } } })) ||
    (await prisma.user.count({ where: { nspId: pin, memberships: { some: { orgId: org.id } } } }))
  );
  await prisma.patrollerProfile.update({ where: { id: cy.id }, data: { clockPin: pin } });
  await prisma.membership.update({ where: { id: cy.membershipId }, data: { updatedAt: new Date() } });
  cy.pin = pin;

  // The harness keeps only what it acts with. The server caches permissions for five
  // seconds, so the narrower set is waited for rather than raced.
  await grant(staffMembership.id, HARNESS);
  await new Promise((r) => setTimeout(r, 5_100));

  const strip = ({ membershipId: _m, ...p }) => p;
  process.stdout.write(JSON.stringify({
    runId,
    apiBase: BASE,
    org: { id: org.id, slug: org.slug },
    staff: {
      userId: staffUser.id,
      permissions: HARNESS,
      accessToken: session.accessToken,
      /** Renews the access token (15 minutes): POST {apiBase}/auth/refresh with Cookie refresh_token=<this>. */
      refreshToken: session.refreshToken,
    },
    resorts: [lodge, summit].map((r) => ({ id: r.id, name: r.name, timeZone: r.timeZone })),
    devices,
    patrollers: [ann, ben, cy].map(strip),
    cleanup: `node apps/api/scripts/tc-harness-seed.mjs${testOrg ? ' --test-org' : ''} --cleanup ${runId}`,
  }, null, 2) + '\n');
  log(`seeded run ${runId} in ${org.slug}`);
} catch (err) {
  log(err);
  log(`seeding failed; removing run ${runId}`);
  await cleanup(runId);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
