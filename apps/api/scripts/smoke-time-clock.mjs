// Walks the time clock's pipeline end to end against a running API and a real
// database (Plan 55): terminals submit clock events, the server folds them into
// shifts, staff correct and reopen them, and what a terminal may not say is
// refused.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-time-clock.mjs
//
// Everything lives in the smoke org and is removed on the way out. Patrollers
// are people, and people are global, so they carry @patrolkit.invalid
// addresses and are deleted by them.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { randomUUID } from 'crypto';

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

const PREFIX = 'Clock smoke';
const MAIL = (n) => `clock-smoke-${n}@patrolkit.invalid`;

const org = await smokeOrg(prisma);

// ─── Fixtures ────────────────────────────────────────────────────────────────

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'clock-smoke-' } }, select: { id: true } });
  const profiles = await prisma.patrollerProfile.findMany({
    where: { membership: { userId: { in: users.map((u) => u.id) } } },
    select: { id: true },
  });
  const ids = profiles.map((p) => p.id);
  await prisma.timeClockEvent.deleteMany({ where: { patrollerId: { in: ids } } });
  await prisma.timeClockShift.deleteMany({ where: { patrollerId: { in: ids } } });
  await prisma.patrollerProfile.deleteMany({ where: { id: { in: ids } } });
  await prisma.membership.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
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
  data: { id: createId(), orgId: org.id, name: `${PREFIX} lodge`, timeZone: 'America/New_York', updatedAt: new Date() },
});
const summit = await prisma.resort.create({
  data: { id: createId(), orgId: org.id, name: `${PREFIX} summit`, timeZone: 'America/New_York', updatedAt: new Date() },
});

const { user: staff } = await smokeStaff(prisma, org, [
  'time_tracking:report', 'time_tracking:manage', 'time_tracking:admin', 'ski_swap:admin',
]);
const staffToken = await smokeSession(prisma, BASE, staff, unwrap);
const H = { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' };

async function terminal(name, resortId) {
  const made = await fetch(`${BASE}/orgs/${org.id}/devices`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: `${PREFIX} ${name}`, role: 'time_clock.terminal', resortId }),
  }).then(unwrap);
  const tok = await fetch(`${BASE}/auth/device/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: made.clientId, clientSecret: made.clientSecret }),
  }).then(unwrap);
  return { id: made.id, H: { authorization: `Bearer ${tok.accessToken}`, 'content-type': 'application/json' } };
}
const termA = await terminal('A', lodge.id);
const termB = await terminal('B', lodge.id);

let nsp = 0;
async function patroller(first) {
  nsp++;
  const p = await fetch(`${BASE}/orgs/${org.id}/time-clock/patrollers`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      firstName: first, lastName: 'Smoke', nspId: `CLKSMOKE${nsp}${Date.now() % 100000}`,
      email: MAIL(`${first.toLowerCase()}-${nsp}`), patrolLevel: 'Senior',
    }),
  }).then(unwrap);
  if (!p.id) throw new Error(`could not create patroller: ${JSON.stringify(p)}`);
  return p;
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const clockIn = (p, at, opts = {}) => ({
  id: randomUUID(), resortId: lodge.id, patrollerId: p.id, type: 'clock_in', dutyType: 'patrol', occurredAt: at, ...opts,
});
const clockOut = (p, at, opts = {}) => ({
  id: randomUUID(), resortId: lodge.id, patrollerId: p.id, type: 'clock_out', occurredAt: at, ...opts,
});
const submit = (term, events) => fetch(`${BASE}/orgs/${org.id}/time-clock/events`, {
  method: 'POST', headers: term.H, body: JSON.stringify({ events }),
}).then(unwrap);
const shiftsOf = (p) => prisma.timeClockShift.findMany({ where: { patrollerId: p.id }, orderBy: { clockInAt: 'asc' } });
const patchShift = (id, body) => fetch(`${BASE}/orgs/${org.id}/time-clock/shifts/${id}`, {
  method: 'PATCH', headers: H, body: JSON.stringify(body),
});

// ─── Clock in, clock out, and retry ──────────────────────────────────────────

const jane = await patroller('Jane');
const batch = [clockIn(jane, hoursAgo(8)), clockOut(jane, hoursAgo(2))];
const first = await submit(termA, batch);
ok('a clock-in and clock-out are both applied',
   first.results?.every((r) => r.status === 'applied'), JSON.stringify(first.results));
const retry = await submit(termA, batch);
ok('a retry of the same batch answers the same', JSON.stringify(retry.results) === JSON.stringify(first.results));
const janeShifts = await shiftsOf(jane);
ok('and leaves exactly one closed shift',
   janeShifts.length === 1 && janeShifts[0].status === 'closed' && janeShifts[0].closeReason === 'manual',
   JSON.stringify(janeShifts.map((s) => [s.status, s.closeReason])));
ok('which knows the event that closed it (D1)', janeShifts[0]?.closeEventId === batch[1].id, janeShifts[0]?.closeEventId);

// ─── Out of order ────────────────────────────────────────────────────────────

const john = await patroller('John');
const morning = clockIn(john, hoursAgo(9));
const afternoon = clockOut(john, hoursAgo(3));
const early = await submit(termB, [afternoon]);
ok('an afternoon clock-out ahead of its clock-in is an orphan for now',
   early.results?.[0]?.status === 'orphan', JSON.stringify(early.results));
await submit(termA, [morning]);
const johnShifts = await shiftsOf(john);
ok('and the morning clock-in arriving later closes the day anyway',
   johnShifts.length === 1 && johnShifts[0].status === 'closed' && johnShifts[0].closeEventId === afternoon.id);
const healed = await prisma.timeClockEvent.findUnique({ where: { id: afternoon.id } });
ok('the clock-out is applied once the fold sees both', healed?.status === 'applied', healed?.status);

// ─── D1: correcting an open shift moves nothing else ─────────────────────────

const maria = await patroller('Maria');
const yesterdayIn = clockIn(maria, hoursAgo(30));
const yesterdayOut = clockOut(maria, hoursAgo(24));
const todayIn = clockIn(maria, hoursAgo(4));
await submit(termA, [yesterdayIn, yesterdayOut, todayIn]);
const fixAt = hoursAgo(1);
const corrected = await patchShift(todayIn.id, { clockOutAt: fixAt });
ok('staff can close an open shift', corrected.status === 200, String(corrected.status));
const mariaShifts = await shiftsOf(maria);
const [yesterday, today] = mariaShifts;
ok("and yesterday's clock-out is where it was (the D1 regression)",
   yesterday?.clockOutAt?.toISOString() === yesterdayOut.occurredAt,
   `${yesterday?.clockOutAt?.toISOString()} vs ${yesterdayOut.occurredAt}`);
ok("today's shift is closed by an admin, at the time given",
   today?.status === 'closed' && today?.closeReason === 'admin' && today?.clockOutAt?.toISOString() === fixAt,
   `${today?.closeReason} ${today?.clockOutAt?.toISOString()}`);

// ─── D2: a reopened shift stays open ─────────────────────────────────────────

const chen = await patroller('Chen');
const chenIn = clockIn(chen, hoursAgo(10));
const auto = clockOut(chen, hoursAgo(6), { id: `auto:${chenIn.id}`, source: 'device_auto' });
await submit(termA, [chenIn, auto]);
const autoClosed = (await shiftsOf(chen))[0];
ok('an automatic close is flagged', autoClosed?.closeReason === 'auto' && autoClosed?.flagged === true);

const reopened = await patchShift(chenIn.id, { clockOutAt: null });
ok('staff can reopen it', reopened.status === 200, String(reopened.status));
const voided = await prisma.timeClockEvent.findUnique({ where: { id: auto.id } });
ok('which sets the close aside rather than deleting it', voided?.status === 'voided', voided?.status);

const late = await submit(termB, [auto]);
ok("a second terminal's late auto close is answered as held",
   late.results?.[0]?.status === 'voided', JSON.stringify(late.results));
const stillOpen = (await shiftsOf(chen))[0];
ok('and the shift stays open', stillOpen?.status === 'open', stillOpen?.status);

const closedAgain = await patchShift(chenIn.id, { clockOutAt: hoursAgo(5) });
const reclosed = (await shiftsOf(chen))[0];
ok('closing it again is an admin close, not a revived auto one',
   closedAgain.status === 200 && reclosed?.status === 'closed' && reclosed?.closeEventId === `admin-close:${chenIn.id}`
     && reclosed?.flagged === false,
   `${reclosed?.status} ${reclosed?.closeEventId} flagged=${reclosed?.flagged}`);
const reopenedTwice = await patchShift(chenIn.id, { clockOutAt: null });
const closedThrice = await patchShift(chenIn.id, { clockOutAt: hoursAgo(4) });
const third = (await shiftsOf(chen))[0];
ok('and a second reopen and close reuses that one rather than colliding with it',
   reopenedTwice.status === 200 && closedThrice.status === 200 && third?.closeEventId === `admin-close:${chenIn.id}`
     && third?.status === 'closed',
   `${reopenedTwice.status} ${closedThrice.status} ${third?.closeEventId}`);

// ─── D3: a device speaks only for itself ─────────────────────────────────────

const aisha = await patroller('Aisha');
const claimsAdmin = clockIn(aisha, hoursAgo(2), { source: 'admin' });
const refused = await submit(termA, [claimsAdmin]);
ok('an admin event from a device is refused',
   refused.results?.[0]?.status === 'rejected' && refused.results?.[0]?.note === 'source_not_allowed',
   JSON.stringify(refused.results));
ok('and never stored', !(await prisma.timeClockEvent.findUnique({ where: { id: claimsAdmin.id } })));

const spoof = clockIn(aisha, hoursAgo(2), { deviceId: termB.id });
await submit(termA, [spoof]);
const spoofed = await prisma.timeClockEvent.findUnique({ where: { id: spoof.id } });
ok("a device's claim to be another device is ignored", spoofed?.deviceId === termA.id, spoofed?.deviceId);
ok('and where it stood is recorded (D4)', spoofed?.deviceResortId === lodge.id, spoofed?.deviceResortId);

const elsewhere = clockOut(aisha, hoursAgo(1), { resortId: summit.id });
await submit(termA, [elsewhere]);
const mismatch = await prisma.timeClockEvent.findUnique({ where: { id: elsewhere.id } });
ok('an event for another resort is accepted, with the mismatch on record',
   mismatch?.status === 'applied' && mismatch?.resortId === summit.id && mismatch?.deviceResortId === lodge.id);

// ─── Batches ─────────────────────────────────────────────────────────────────

const tom = await patroller('Tom');
const twice = clockIn(tom, hoursAgo(3));
const doubled = await submit(termA, [twice, twice]);
ok('the same id twice in one batch gets one answer, and no error',
   doubled.results?.length === 1 && doubled.results[0].status === 'applied', JSON.stringify(doubled));

const future = clockIn(tom, new Date(Date.now() + 3 * 24 * 3600_000).toISOString());
const fromTheFuture = await submit(termA, [future]);
ok('an event days in the future is refused as a bad clock',
   fromTheFuture.results?.[0]?.note === 'clock_implausible', JSON.stringify(fromTheFuture.results));
const kept = await prisma.timeClockEvent.findUnique({ where: { id: future.id } });
ok('and kept, so staff can see the clock', kept?.status === 'rejected', kept?.status);

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await cleanup();
await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
