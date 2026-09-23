// The test that the Plan 26 model holds: a doors-open rush, everybody on the
// venue's wifi, and not one request refused.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/load-venue-rush.mjs
//
// Replays the self check-in measured in Plan 26 §3, as the plan's heavy seller
// — three codes, two of them mistyped, four page loads, four refreshes, fifteen
// items with a photo each — with twenty sellers arriving a minute for five
// minutes, every request from one forwarded address. Asserts zero 429s.
//
// Then it raises the arrival rate step by step and reports where the first
// refusal lands, so the headroom is a number we have seen rather than one we
// computed. And it reads the Server health page to check the rush is there, at
// roughly the percentage §3 predicts, attributed to this swap.
//
// Takes about fifteen minutes. Local only: it creates hundreds of users and
// would send hundreds of codes on a host with delivery switched on. Set
// LOAD_ALLOW_REMOTE=1 to point it anywhere else, and think first.
//
// Two stand-ins, both on the per-account side where the budget is 600 a minute
// per route and a seller uses a few dozen in total: a photo upload is replayed
// as a summary read, and each seller's session is compressed from eight minutes
// to about two. Compressing it makes the per-address traffic, which is what is
// under test, denser than a real rush, not lighter.

import { PrismaClient } from '@prisma/client';
import { forceChallengeCode, smokeOrg, smokeSession, smokeSuperAdmin, dropSmokeAdmin } from './_fixture.mjs';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE) && process.env.LOAD_ALLOW_REMOTE !== '1') {
  console.error(`Refusing to load-test ${BASE}. Set LOAD_ALLOW_REMOTE=1 if you mean it.`);
  process.exit(2);
}

const prisma = new PrismaClient();
const RUN = Date.now().toString(36);
const VENUE = `198.51.100.${Math.floor(Math.random() * 250) + 2}`;
const RUSH_PER_MINUTE = 20;
const RUSH_MINUTES = 5;
/** Between one seller's own requests once signed in: ~75 of them in two minutes. */
const PACE_MS = 1_500;
const ITEMS = 15;

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};
const unwrap = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fixtures ────────────────────────────────────────────────────────────────
const org = await smokeOrg(prisma);
// Whatever an interrupted run left behind, and the station code it would clash
// with — codes are unique within an org.
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, OR: [{ code: 'R' }, { name: { startsWith: 'Rush station' } }] } });
for (const old of await prisma.skiSwap.findMany({ where: { orgId: org.id, title: { startsWith: 'Venue rush' } } })) {
  await prisma.swapItem.deleteMany({ where: { swapId: old.id } });
  await prisma.printJob.deleteMany({ where: { swapId: old.id } });
  await prisma.receipt.deleteMany({ where: { swapId: old.id } });
  await prisma.skiSwap.delete({ where: { id: old.id } });
}
await prisma.user.deleteMany({ where: { email: { startsWith: 'rush-' }, AND: { email: { endsWith: '@patrolkit.invalid' } } } });
await prisma.taxonomyNode.deleteMany({ where: { orgId: org.id, label: { startsWith: 'Rush ' } } });
const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, title: `Venue rush ${RUN}`, squareCategoryId: 'load',
    skuPrefix: 'VR', active: true, activeSkuPrefix: `VR${RUN}`.slice(0, 8),
  },
});
const station = await prisma.checkinStation.create({
  data: { orgId: org.id, name: `Rush station ${RUN}`, code: 'R' },
});
const category = await prisma.taxonomyNode.create({
  data: { kind: 'CATEGORY', orgId: org.id, label: `Rush ${RUN}`, dedupeKey: `${org.id}:root:rush ${RUN}` },
});

// ─── One seller ──────────────────────────────────────────────────────────────

/** Every refusal, with where and when, across the whole run. */
const refusals = [];
let sent = 0;

async function call(path, init = {}, label = path) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': VENUE, ...(init.headers ?? {}) },
  });
  sent++;
  if (res.status === 429) refusals.push({ at: Date.now(), label });
  return res;
}

async function seller(n) {
  const email = `rush-${RUN}-${n}@patrolkit.invalid`;
  const page = () => call(`/public/checkin/${swap.id}?station=${station.id}`, {}, 'check-in page');
  const register = () =>
    call(`/public/checkin/${swap.id}/register?station=${station.id}`,
      { method: 'POST', body: JSON.stringify({ email }) }, 'register').then(unwrap);

  // Arrives, scans, asks for a code, reloads, asks twice more.
  await page();
  await register();
  await page();
  await register();
  const reg = await register();
  await page();
  await page();

  // Two mistyped codes, then the right one.
  const confirm = (code) =>
    call(`/auth/challenges/${reg.challengeId}/confirm`, { method: 'POST', body: JSON.stringify({ code }) }, 'confirm');
  if (!reg.challengeId) return; // refused at register; already recorded
  await confirm('000000');
  await confirm('000001');
  const code = await forceChallengeCode(prisma, reg.challengeId);
  const signedIn = await confirm(code);
  let cookie = cookieFrom(signedIn);
  const { accessToken } = await unwrap(signedIn);
  const auth = { authorization: `Bearer ${accessToken}` };

  const authed = async (path, init = {}, label = path) => {
    await sleep(PACE_MS);
    return call(path, { ...init, headers: { ...auth, ...(init.headers ?? {}) } }, label);
  };
  const refresh = async () => {
    await sleep(PACE_MS);
    const res = await call('/auth/refresh', { method: 'POST', headers: { cookie } }, 'refresh');
    cookie = cookieFrom(res) || cookie;
  };
  const summary = () => authed(`/orgs/${org.id}/ski-swap/checkin/summary?swapId=${swap.id}`, {}, 'summary');
  const taxonomy = () => authed(`/orgs/${org.id}/ski-swap/taxonomy`, {}, 'taxonomy');

  await authed(`/orgs/${org.id}/ski-swap/checkin/join`,
    { method: 'POST', body: JSON.stringify({ swapId: swap.id, stationId: station.id }) }, 'join');
  await authed('/me', {}, '/me');
  for (const patch of [{ firstName: 'Rush' }, { lastName: `Seller ${n}` }, { street: '1 Lodge Rd' }]) {
    await authed(`/orgs/${org.id}/ski-swap/seller/me`, { method: 'PATCH', body: JSON.stringify(patch) }, 'profile');
  }
  await taxonomy();
  await authed('/me', {}, '/me');

  for (let i = 0; i < ITEMS; i++) {
    await authed(`/orgs/${org.id}/ski-swap/seller/me/items`, {
      method: 'POST',
      body: JSON.stringify({ swapId: swap.id, categoryId: category.id, priceCents: 5000 + i, quantity: 1, stationId: station.id }),
    }, 'item');
    await summary();
    await summary();
    await summary(); // the photo, see the header
    if (i % 3 === 0) await taxonomy();
    if (i % 4 === 3) await refresh();
  }
  await refresh();
}

function cookieFrom(res) {
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

/** Starts `perMinute` sellers a minute for `minutes`, and waits for them all. */
async function arrive(perMinute, minutes, first) {
  const sellers = [];
  const total = Math.round(perMinute * minutes);
  for (let i = 0; i < total; i++) {
    sellers.push(seller(first + i).catch((err) => { failures++; console.error('seller failed:', err.message); }));
    await sleep(60_000 / perMinute);
  }
  await Promise.all(sellers);
  return first + total;
}

async function health(token, limitId) {
  const res = await fetch(`${BASE}/admin/health/limits/${limitId}/series?range=24h`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(unwrap);
  return res.top?.find((p) => p.swap?.id === swap.id);
}

// ─── The rush ────────────────────────────────────────────────────────────────
console.log(`Rush: ${RUSH_PER_MINUTE} sellers a minute for ${RUSH_MINUTES} minutes, all from ${VENUE}`);
const started = Date.now();
let next = await arrive(RUSH_PER_MINUTE, RUSH_MINUTES, 0);
ok(`${next} heavy sellers, ${sent} requests from one address, and none refused`,
  refusals.length === 0, refusals.length ? `${refusals.length} refused, first at ${refusals[0].label}` : '');

// ─── The health page saw it ──────────────────────────────────────────────────
const admin = await smokeSuperAdmin(prisma);
const adminToken = await smokeSession(prisma, BASE, admin, unwrap);
// §3: three registrations per seller, twenty sellers a minute, against 200.
const predicted = (3 * RUSH_PER_MINUTE * 100) / 200;
const register = await health(adminToken, 'checkin.register');
ok(`the health page shows the rush at about the ${predicted}% §3 predicts, at this swap`,
  !!register && register.percent >= predicted * 0.6 && register.percent <= predicted * 1.5,
  JSON.stringify(register));

// ─── Where it breaks ─────────────────────────────────────────────────────────
// Up in steps until something is refused. Each step lasts long enough for a
// full minute's window to fill.
let rate = RUSH_PER_MINUTE * 2;
const before = refusals.length;
while (refusals.length === before && rate <= RUSH_PER_MINUTE * 6) {
  console.log(`Step: ${rate} sellers a minute`);
  next = await arrive(rate, 2, next);
  if (refusals.length === before) rate += RUSH_PER_MINUTE;
}
const first = refusals[before];
console.log(first
  ? `\nFirst refusal at ${rate} sellers a minute (${(rate / RUSH_PER_MINUTE).toFixed(1)}× the rush), on ${first.label}.`
  : `\nNothing refused up to ${rate - RUSH_PER_MINUTE} sellers a minute.`);
console.log(`${sent} requests in ${Math.round((Date.now() - started) / 60_000)} minutes.`);

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.user.deleteMany({ where: { email: { startsWith: `rush-${RUN}-` } } });
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.printJob.deleteMany({ where: { swapId: swap.id } });
await prisma.receipt.deleteMany({ where: { swapId: swap.id } });
await prisma.checkinStation.delete({ where: { id: station.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.taxonomyNode.delete({ where: { id: category.id } });
await dropSmokeAdmin(prisma);
await prisma.$disconnect();

console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
