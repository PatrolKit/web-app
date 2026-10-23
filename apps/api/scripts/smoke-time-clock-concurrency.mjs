// Two terminals at once (Plan 55 D8): events for the same patroller arriving in
// parallel must fold to exactly what one replay of the whole log gives, and the
// same event id from two terminals at once must land once, with no 500.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-time-clock-concurrency.mjs

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { randomUUID } from 'crypto';

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const ROUNDS = Number(process.env.ROUNDS ?? 20);
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

const PREFIX = 'Clock race';
const org = await smokeOrg(prisma);

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'clock-race-' } }, select: { id: true } });
  const profiles = await prisma.patrollerProfile.findMany({
    where: { membership: { userId: { in: users.map((u) => u.id) } } }, select: { id: true },
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
  data: { id: createId(), orgId: org.id, name: `${PREFIX} lodge`, timeZone: 'America/Denver', updatedAt: new Date() },
});
const { user: staff } = await smokeStaff(prisma, org, [
  'time_tracking:report', 'time_tracking:manage', 'time_tracking:admin', 'ski_swap:admin', 'org:manage',
]);
const H = { authorization: `Bearer ${await smokeSession(prisma, BASE, staff, unwrap)}`, 'content-type': 'application/json' };

async function terminal(name) {
  const made = await fetch(`${BASE}/orgs/${org.id}/devices`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: `${PREFIX} ${name}`, role: 'time_clock.terminal', resortId: lodge.id }),
  }).then(unwrap);
  const tok = await fetch(`${BASE}/auth/device/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: made.clientId, clientSecret: made.clientSecret }),
  }).then(unwrap);
  return { authorization: `Bearer ${tok.accessToken}`, 'content-type': 'application/json' };
}
const A = await terminal('A');
const B = await terminal('B');

const p = await fetch(`${BASE}/orgs/${org.id}/time-clock/patrollers`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    firstName: 'Race', lastName: 'Smoke', nspId: `CLKRACE${Date.now() % 1000000}`,
    email: `clock-race-${Date.now()}@patrolkit.invalid`,
  }),
}).then(unwrap);

const submit = (h, events) => fetch(`${BASE}/orgs/${org.id}/time-clock/events`, {
  method: 'POST', headers: h, body: JSON.stringify({ events }),
});
const day = (n, h) => new Date(Date.now() - (ROUNDS + 2 - n) * 24 * 3600_000 + h * 3600_000).toISOString();

// Each round is one day: A sends the clock-in while B sends the clock-out, at the same
// moment. Whatever order they commit in, the day must end up one closed shift.
let statusErrors = 0;
for (let n = 0; n < ROUNDS; n++) {
  const inId = randomUUID();
  const [a, b] = await Promise.all([
    submit(A, [{ id: inId, resortId: lodge.id, patrollerId: p.id, type: 'clock_in', dutyType: 'patrol', occurredAt: day(n, 8) }]),
    submit(B, [{ id: randomUUID(), resortId: lodge.id, patrollerId: p.id, type: 'clock_out', occurredAt: day(n, 16) }]),
  ]);
  if (a.status >= 500 || b.status >= 500) statusErrors++;
}
ok('parallel batches for one patroller never fail', statusErrors === 0, `${statusErrors} server errors`);

const shifts = await prisma.timeClockShift.findMany({ where: { patrollerId: p.id, deletedAt: null } });
ok(`${ROUNDS} racing days fold to ${ROUNDS} closed shifts`,
   shifts.length === ROUNDS && shifts.every((s) => s.status === 'closed' && s.closeReason === 'manual'),
   `${shifts.length} shifts: ${[...new Set(shifts.map((s) => `${s.status}/${s.closeReason}`))].join(', ')}`);
const events = await prisma.timeClockEvent.findMany({ where: { patrollerId: p.id } });
ok('and every event is applied', events.every((e) => e.status === 'applied'),
   [...new Set(events.map((e) => e.status))].join(', '));

// The same id from both terminals at once: one insert wins, the other reads it back.
let collisions = 0;
for (let n = 0; n < ROUNDS; n++) {
  const event = { id: randomUUID(), resortId: lodge.id, patrollerId: p.id, type: 'clock_in', dutyType: 'patrol', occurredAt: new Date(Date.now() - 3600_000 + n * 1000).toISOString() };
  const [a, b] = await Promise.all([submit(A, [event]), submit(B, [event])]);
  const [ra, rb] = await Promise.all([unwrap(a), unwrap(b)]);
  if (a.status !== 200 || b.status !== 200 || !ra.results?.[0]?.status || !rb.results?.[0]?.status) collisions++;
}
ok('the same id from two terminals at once lands once, with an answer for both', collisions === 0, `${collisions} bad rounds`);

await cleanup();
await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
