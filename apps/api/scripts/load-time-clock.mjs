// A season's worth of time clock (Plan 55): 500 patrollers, 5,000 events, and one
// patroller with a heavy season. Measures what the fold costs as history grows,
// because the server replays a patroller's whole log on every batch.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/load-time-clock.mjs
//
// Writes straight to the database for the bulk (the API would take minutes), then
// times the API on top of it. Local databases only: it refuses a SMOKE_BASE that
// is not localhost.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { randomUUID } from 'crypto';

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(BASE)) throw new Error('load-time-clock runs against a local API only');
const PATROLLERS = 500;
const ENTRIES_EACH = 5; // 10 events each: 5,000 in all
const HEAVY_ENTRIES = 150; // a patroller who worked most days of a season
const BUDGET_MS = 1000;

const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

const PREFIX = 'Clock load';
const org = await smokeOrg(prisma);

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'clock-load-' } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const profiles = await prisma.patrollerProfile.findMany({ where: { membership: { userId: { in: userIds } } }, select: { id: true } });
  const ids = profiles.map((p) => p.id);
  await prisma.timeClockEvent.deleteMany({ where: { patrollerId: { in: ids } } });
  await prisma.timeEntry.deleteMany({ where: { patrollerId: { in: ids } } });
  await prisma.patrollerProfile.deleteMany({ where: { id: { in: ids } } });
  await prisma.membership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.device.deleteMany({ where: { orgId: org.id, name: { startsWith: PREFIX } } });
  await prisma.resort.deleteMany({ where: { orgId: org.id, name: { startsWith: PREFIX } } });
}
await cleanup();

await prisma.orgModule.upsert({
  where: { orgId_moduleKey: { orgId: org.id, moduleKey: 'time_tracking' } },
  update: { enabled: true },
  create: { id: createId(), orgId: org.id, moduleKey: 'time_tracking', enabled: true, enabledAt: new Date() },
});
const lodge = await prisma.resort.create({
  data: { id: createId(), orgId: org.id, name: `${PREFIX} lodge`, timeZone: 'America/Denver', updatedAt: new Date() },
});

// ─── The bulk, straight into the database ───────────────────────────────────

const stamp = Date.now();
const people = Array.from({ length: PATROLLERS + 1 }, (_, i) => ({
  userId: createId(), membershipId: createId(), profileId: createId(),
  email: `clock-load-${stamp}-${i}@patrolkit.invalid`, nspId: `CLKLOAD${stamp % 100000}X${i}`,
}));
await prisma.user.createMany({
  data: people.map((p, i) => ({ id: p.userId, email: p.email, nspId: p.nspId, firstName: `Load${i}`, lastName: 'Smoke' })),
});
await prisma.membership.createMany({
  data: people.map((p) => ({ id: p.membershipId, userId: p.userId, orgId: org.id, updatedAt: new Date() })),
});
await prisma.patrollerProfile.createMany({
  data: people.map((p) => ({ id: p.profileId, membershipId: p.membershipId, updatedAt: new Date() })),
});

const dayStart = (daysAgo) => Date.now() - daysAgo * 24 * 3600_000;
const eventsFor = (profileId, entries) => Array.from({ length: entries }).flatMap((_, d) => [
  { id: randomUUID(), orgId: org.id, resortId: lodge.id, patrollerId: profileId, type: 'clock_in', dutyType: 'patrol',
    occurredAt: new Date(dayStart(entries + 2 - d)), source: 'device' },
  { id: randomUUID(), orgId: org.id, resortId: lodge.id, patrollerId: profileId, type: 'clock_out',
    occurredAt: new Date(dayStart(entries + 2 - d) + 7 * 3600_000), source: 'device' },
]);
const heavy = people[PATROLLERS];
const bulk = [
  ...people.slice(0, PATROLLERS).flatMap((p) => eventsFor(p.profileId, ENTRIES_EACH)),
  ...eventsFor(heavy.profileId, HEAVY_ENTRIES),
];
for (let i = 0; i < bulk.length; i += 1000) await prisma.timeClockEvent.createMany({ data: bulk.slice(i, i + 1000) });
console.log(`seeded ${PATROLLERS + 1} patrollers and ${bulk.length} events`);

// ─── Timed, through the API ─────────────────────────────────────────────────

const { user: staff } = await smokeStaff(prisma, org, [
  'time_tracking:report', 'time_tracking:manage', 'time_tracking:admin', 'ski_swap:admin', 'org:manage',
]);
const H = { authorization: `Bearer ${await smokeSession(prisma, BASE, staff, unwrap)}`, 'content-type': 'application/json' };
const made = await fetch(`${BASE}/orgs/${org.id}/devices`, {
  method: 'POST', headers: H, body: JSON.stringify({ name: `${PREFIX} terminal`, role: 'time_clock.terminal', resortId: lodge.id }),
}).then(unwrap);
const tok = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: made.clientId, clientSecret: made.clientSecret }),
}).then(unwrap);
const D = { authorization: `Bearer ${tok.accessToken}`, 'content-type': 'application/json' };

const timed = async (fn) => { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; };
const submit = (events) => fetch(`${BASE}/orgs/${org.id}/time-clock/events`, {
  method: 'POST', headers: D, body: JSON.stringify({ events }),
}).then(unwrap);
const clockIn = (patrollerId) => ({
  id: randomUUID(), resortId: lodge.id, patrollerId, type: 'clock_in', dutyType: 'patrol', occurredAt: new Date(Date.now() - 3600_000).toISOString(),
});

// The first batch per patroller folds a log nothing has folded yet: every entry is new.
const [firstMs] = await timed(() => submit([clockIn(heavy.profileId)]));
await new Promise((r) => setTimeout(r, 20));
const afterFirst = new Date();
const [againMs, again] = await timed(() => submit([{
  id: randomUUID(), resortId: lodge.id, patrollerId: heavy.profileId, type: 'clock_out', occurredAt: new Date(Date.now() - 60_000).toISOString(),
}]));
ok(`one batch for a patroller with ${HEAVY_ENTRIES} entries of history recomputes under ${BUDGET_MS} ms`,
   againMs < BUDGET_MS && again.results?.[0]?.status === 'applied',
   `${Math.round(againMs)} ms (first fold of the whole log: ${Math.round(firstMs)} ms)`);

const touched = await prisma.timeEntry.count({
  where: { patrollerId: heavy.profileId, updatedAt: { gt: afterFirst } },
});
ok('and it rewrote only the entry it changed', touched === 1, `${touched} entries written`);

// Everyone else folds on their first batch, in batches of 50 patrollers.
const [crowdMs] = await timed(async () => {
  for (let i = 0; i < PATROLLERS; i += 50) {
    await submit(people.slice(i, i + 50).map((p) => clockIn(p.profileId)));
  }
});
console.log(`      folding ${PATROLLERS} patrollers' first logs, 50 a batch: ${Math.round(crowdMs)} ms`);

const [rosterMs, roster] = await timed(async () => {
  let page = await fetch(`${BASE}/orgs/${org.id}/time-clock/patrollers?walk=true`, { headers: D }).then(unwrap);
  let n = page.patrollers.length;
  while (page.nextAfter) {
    page = await fetch(`${BASE}/orgs/${org.id}/time-clock/patrollers?walk=true&after=${page.nextAfter}`, { headers: D }).then(unwrap);
    n += page.patrollers.length;
  }
  return n;
});
ok(`a terminal walks a ${PATROLLERS}-person roster in under ${BUDGET_MS * 2} ms`, rosterMs < BUDGET_MS * 2 && roster >= PATROLLERS,
   `${Math.round(rosterMs)} ms, ${roster} rows`);

const [entriesMs, entryCount] = await timed(async () => {
  let page = await fetch(`${BASE}/orgs/${org.id}/time-clock/entries?walk=true`, { headers: D }).then(unwrap);
  let n = page.entries.length;
  while (page.nextAfter) {
    page = await fetch(`${BASE}/orgs/${org.id}/time-clock/entries?walk=true&after=${page.nextAfter}`, { headers: D }).then(unwrap);
    n += page.entries.length;
  }
  return n;
});
console.log(`      a fresh terminal's first walk of every entry: ${Math.round(entriesMs)} ms for ${entryCount}`);

const [hoursMs] = await timed(() => fetch(`${BASE}/orgs/${org.id}/time-clock/reports/hours`, { headers: H }).then(unwrap));
ok(`the hours report over ${entryCount} entries answers in under ${BUDGET_MS * 2} ms`, hoursMs < BUDGET_MS * 2, `${Math.round(hoursMs)} ms`);

await cleanup();
await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
