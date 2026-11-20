// The time clock from any source (Plan 59), against a running API and a real database:
// a patroller's own clock on a phone or the web, iPads, staff, and the server's sweep, all
// in one log. Each check names the edge case it stands for (Plan 59 §8).
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-time-clock-any-source.mjs
//
// Sign-in is throttled to five a minute, and this signs in three people: leave a minute
// after another smoke. Everything lives in the smoke org and is removed on the way out.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { randomUUID } from 'crypto';

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const body = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

const PREFIX = 'Any source smoke';
const MAIL = (n) => `any-source-smoke-${n}@patrolkit.invalid`;
const org = await smokeOrg(prisma);

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'any-source-smoke-' } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const profiles = await prisma.patrollerProfile.findMany({ where: { membership: { userId: { in: userIds } } }, select: { id: true } });
  const ids = profiles.map((p) => p.id);
  await prisma.timeClockEvent.deleteMany({ where: { patrollerId: { in: ids } } });
  await prisma.timeEntry.deleteMany({ where: { patrollerId: { in: ids } } });
  await prisma.patrollerProfile.deleteMany({ where: { id: { in: ids } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.contactChallenge.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.membership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.device.deleteMany({ where: { orgId: org.id, name: { startsWith: PREFIX } } });
  await prisma.resort.deleteMany({ where: { orgId: org.id, name: { startsWith: PREFIX } } });
}
await cleanup();

const enable = (enabled) => prisma.orgModule.upsert({
  where: { orgId_moduleKey: { orgId: org.id, moduleKey: 'time_tracking' } },
  update: { enabled },
  create: { id: createId(), orgId: org.id, moduleKey: 'time_tracking', enabled, enabledAt: new Date() },
});
await enable(true);
const resort = (name) => prisma.resort.create({
  data: { id: createId(), orgId: org.id, name: `${PREFIX} ${name}`, timeZone: 'America/New_York', updatedAt: new Date() },
});
const lodge = await resort('lodge');
const summit = await resort('summit');

// The sweep time 12 hours from now: the last 12 hours' clock-ins are never swept, older ones are.
const sweepTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .format(new Date(Date.now() + 12 * 3600_000));
await prisma.timeClockSettings.upsert({
  where: { orgId: org.id },
  update: { autoCloseLocalTime: sweepTime, autoCloseAfterHours: 4 },
  create: { id: createId(), orgId: org.id, autoCloseLocalTime: sweepTime, autoCloseAfterHours: 4 },
});

const { user: staff } = await smokeStaff(prisma, org, [
  'time_tracking:report', 'time_tracking:manage', 'time_tracking:admin', 'org:manage', 'org:read', 'modules:manage',
  'users:read', 'users:invite', 'users:manage',
]);
const H = { authorization: `Bearer ${await smokeSession(prisma, BASE, staff, body)}`, 'content-type': 'application/json' };
const staffCall = (method, path, payload) => fetch(`${BASE}/orgs/${org.id}${path}`, {
  method, headers: H, ...(payload ? { body: JSON.stringify(payload) } : {}),
});

// ─── R11: a tablet's resort is chosen on the iPad ────────────────────────────

const placed = await staffCall('POST', '/devices', { name: `${PREFIX} placed`, role: 'org.tablet', resortId: lodge.id });
ok('a tablet is not given a resort on the website (E21)', placed.status === 400, String(placed.status));

async function tablet(name, resortId) {
  const made = await staffCall('POST', '/devices', { name: `${PREFIX} ${name}`, role: 'org.tablet' }).then(body);
  const tok = await fetch(`${BASE}/auth/device/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: made.clientId, clientSecret: made.clientSecret }),
  }).then(body);
  const T = { authorization: `Bearer ${tok.accessToken}`, 'content-type': 'application/json' };
  const bound = await fetch(`${BASE}/devices/me/resort`, { method: 'PATCH', headers: T, body: JSON.stringify({ resortId }) });
  return { id: made.id, H: T, bound: bound.status };
}
const lodgeIpad = await tablet('lodge iPad', lodge.id);
const summitIpad = await tablet('summit iPad', summit.id);
ok('it binds itself from the iPad', lodgeIpad.bound === 200 && summitIpad.bound === 200, `${lodgeIpad.bound} ${summitIpad.bound}`);
const fromWeb = await staffCall('PATCH', `/devices/${lodgeIpad.id}/resort`, { resortId: summit.id });
ok('and the website cannot move it', fromWeb.status === 400, String(fromWeb.status));

// ─── People ──────────────────────────────────────────────────────────────────

let n = 0;
async function patroller(first, { session = false } = {}) {
  n++;
  const email = MAIL(`${first.toLowerCase()}-${n}`);
  const m = await staffCall('POST', '/members', {
    firstName: first, lastName: 'Smoke', nspId: `ANYSRC${n}${Date.now() % 100000}`, email, patrolLevel: 'Basic', permissions: [],
  }).then(body);
  if (!m.membershipId) throw new Error(`could not add member: ${JSON.stringify(m)}`);
  const profile = await prisma.patrollerProfile.findUniqueOrThrow({ where: { membershipId: m.membershipId } });
  const p = { id: profile.id, userId: m.userId };
  if (session) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: m.userId } });
    const P = { authorization: `Bearer ${await smokeSession(prisma, BASE, user, body)}`, 'content-type': 'application/json' };
    p.call = (method, path, payload) => fetch(`${BASE}/me/orgs/${org.id}/time-clock${path}`, {
      method, headers: P, ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  }
  return p;
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const ipadIn = (p, at, o = {}) => ({ id: randomUUID(), resortId: lodge.id, patrollerId: p.id, type: 'clock_in', dutyType: 'patrol', occurredAt: at, ...o });
const ipadOut = (p, at, entryId, o = {}) => ({ id: randomUUID(), resortId: lodge.id, patrollerId: p.id, type: 'clock_out', occurredAt: at, entryId, ...o });
const send = (ipad, events) => fetch(`${BASE}/orgs/${org.id}/time-clock/events`, {
  method: 'POST', headers: ipad.H, body: JSON.stringify({ events }),
}).then(body);
const entriesOf = (p) => prisma.timeEntry.findMany({ where: { patrollerId: p.id, deletedAt: null }, orderBy: { clockInAt: 'asc' } });
const eventOf = (id) => prisma.timeClockEvent.findUnique({ where: { id } });

// ─── A patroller's own clock (R6, R7) ────────────────────────────────────────

const ann = await patroller('Ann', { session: true });
const none = await ann.call('GET', '/shift').then(body);
ok('her phone sees no shift', none.entry === null, JSON.stringify(none));

const inId = randomUUID();
const clockedIn = await ann.call('POST', '/events', { id: inId, type: 'clock_in', resortId: lodge.id, dutyType: 'patrol', location: { lat: 44.1, lon: -71.2, accuracyM: 12 } }).then(body);
ok('she clocks in on her phone', clockedIn.event?.status === 'applied' && clockedIn.entry?.id === inId && clockedIn.entry?.status === 'open',
   JSON.stringify(clockedIn.event));
const stored = await eventOf(inId);
ok("at the server's time, from where she was (R7)",
   stored?.source === 'member' && Math.abs(stored.occurredAt.getTime() - Date.now()) < 60_000 && stored.latitude === 44.1);
const retried = await ann.call('POST', '/events', { id: inId, type: 'clock_in', resortId: lodge.id, dutyType: 'patrol' }).then(body);
ok('a retry answers the same', retried.event?.status === 'applied' && retried.entry?.id === inId);

const again = await ann.call('POST', '/events', { id: randomUUID(), type: 'clock_in', resortId: summit.id, dutyType: 'patrol' });
const againBody = await again.json();
ok('a second clock-in is refused while she is on shift (E1, E8)',
   again.status === 409 && againBody.code === 'on_shift' && againBody.details?.entry?.id === inId, `${again.status} ${againBody.code}`);

const tooEarly = await ann.call('POST', '/events', { id: randomUUID(), type: 'clock_out', entryId: inId, chosenAt: hoursAgo(5) });
ok('a chosen clock-out before her clock-in is refused', tooEarly.status === 400, String(tooEarly.status));
const outId = randomUUID();
const chosen = new Date(stored.occurredAt.getTime() + 1).toISOString();
const clockedOut = await ann.call('POST', '/events', { id: outId, type: 'clock_out', entryId: inId, chosenAt: chosen }).then(body);
ok('she closes it at a time she chooses (E1)',
   clockedOut.event?.status === 'applied' && clockedOut.event?.note === 'chosen_time' && clockedOut.entry?.clockOutAt === chosen,
   JSON.stringify(clockedOut));
const back = await ann.call('POST', '/events', { id: randomUUID(), type: 'clock_in', resortId: summit.id, dutyType: 'training' }).then(body);
ok('and then clocks in elsewhere', back.event?.status === 'applied' && back.entry?.resortId === summit.id);

const ben = await patroller('Ben', { session: true });
const someoneElses = await ben.call('POST', '/events', { id: randomUUID(), type: 'clock_out', entryId: inId });
ok("she can't clock out someone else's shift", someoneElses.status === 404, String(someoneElses.status));
const stolenId = await ben.call('POST', '/events', { id: inId, type: 'clock_in', resortId: lodge.id, dutyType: 'patrol' }).then(body);
ok("nor reuse someone else's event id", stolenId.event?.status === 'rejected' && stolenId.event?.note === 'id_conflict');

// ─── iPads and phones in one log (R2, R3) ────────────────────────────────────

const benPhone = randomUUID();
await ben.call('POST', '/events', { id: benPhone, type: 'clock_in', resortId: lodge.id, dutyType: 'patrol' });
const heldIn = ipadIn(ben, hoursAgo(1));
const synced = await send(lodgeIpad, [heldIn]);
const benShift = await ben.call('GET', '/shift').then(body);
ok("an offline iPad's earlier clock-in becomes the shift's start (E20)",
   synced.results?.[0]?.status === 'applied' && benShift.entry?.id === heldIn.id && (await eventOf(benPhone))?.status === 'duplicate',
   JSON.stringify(benShift.entry?.id));
const benOut = await ben.call('POST', '/events', { id: randomUUID(), type: 'clock_out', entryId: benPhone }).then(body);
ok('and her phone, naming its own clock-in, still closes it', benOut.event?.status === 'applied' && benOut.entry?.id === heldIn.id
   && benOut.entry?.status === 'closed', JSON.stringify(benOut.event));

const cy = await patroller('Cy');
const cyIn = ipadIn(cy, hoursAgo(3));
const cyDup = ipadIn(cy, hoursAgo(2), { resortId: summit.id });
await send(lodgeIpad, [cyIn]);
const dup = await send(summitIpad, [cyDup]);
ok('a clock-in at another resort during her shift is a duplicate (E19)', dup.results?.[0]?.status === 'duplicate', JSON.stringify(dup.results));
const cyOut = ipadOut(cy, hoursAgo(1), cyDup.id, { resortId: summit.id });
await send(summitIpad, [cyOut]);
const cyEntries = await entriesOf(cy);
ok('and a clock-out naming that duplicate closes the one shift (E17)',
   cyEntries.length === 1 && cyEntries[0].id === cyIn.id && cyEntries[0].closeEventId === cyOut.id);

// ─── Only the server sweeps (R4, R5) ─────────────────────────────────────────

const dee = await patroller('Dee', { session: true });
const deeIn = ipadIn(dee, hoursAgo(30));
const deeAuto = ipadOut(dee, hoursAgo(26), deeIn.id, { id: `auto:${deeIn.id}`, source: 'device_auto' });
const deeSent = await send(lodgeIpad, [deeIn, deeAuto]);
const deeSwept = (await entriesOf(dee))[0];
ok("an iPad's own auto clock-out changes nothing (E14)", deeSent.results?.[1]?.status === 'orphan' && deeSent.results?.[1]?.note === 'server_sweeps');
ok('the server sweeps the forgotten shift, flagged (E2)',
   deeSwept?.closeEventId === `sweep:${deeIn.id}:1` && deeSwept?.closeReason === 'auto' && deeSwept?.flagged === true,
   `${deeSwept?.closeEventId} ${deeSwept?.closeReason}`);
const tooLate = await dee.call('POST', '/events', { id: randomUUID(), type: 'clock_out', entryId: deeIn.id }).then(body);
ok('a clock-out after the sweep changes nothing (E12)', tooLate.event?.status === 'orphan' && tooLate.entry?.closeReason === 'auto');
const lateReal = ipadOut(dee, hoursAgo(25), deeIn.id);
await send(lodgeIpad, [lateReal]);
const deeHeld = (await entriesOf(dee))[0];
ok("a real clock-out dated before the sweep moment still beats it (E3)",
   deeHeld?.closeEventId === lateReal.id && deeHeld?.closeReason === 'manual', `${deeHeld?.closeEventId}`);
const reopened = await staffCall('PATCH', `/time-clock/entries/${deeIn.id}`, { clockOutAt: null });
const deeLog = await dee.call('GET', '/shift').then(body);
const resweep = await eventOf(`sweep:${deeIn.id}:2`);
ok('a reopened shift is swept again (E5, E11)', reopened.status === 200 && deeLog.entry === null && resweep?.status === 'applied',
   `${reopened.status} ${resweep?.status}`);

// ─── R9: patrollers ──────────────────────────────────────────────────────────

const eve = await patroller('Eve', { session: true });
await prisma.patrollerProfile.update({ where: { id: eve.id }, data: { active: false } });
const offIn = ipadIn(eve, hoursAgo(1));
const off = await send(lodgeIpad, [offIn]);
const eveEntry = (await entriesOf(eve))[0];
ok('an iPad clock-in from someone inactive is accepted and flagged (E16)',
   off.results?.[0]?.status === 'applied' && off.results?.[0]?.note === 'inactive_patroller' && eveEntry?.flagged === true);
const eveOwn = await eve.call('GET', '/shift');
ok('but she cannot use her own clock', eveOwn.status === 403, String(eveOwn.status));

// ─── R8: staff ───────────────────────────────────────────────────────────────

const fay = await patroller('Fay');
const halfShift = await staffCall('POST', `/time-clock/patrollers/${fay.id}/shifts`, { resortId: lodge.id, dutyType: 'patrol', clockInAt: hoursAgo(30) });
ok('staff must enter the whole of a past shift (E6)', halfShift.status === 400 && (await halfShift.json()).code === 'needs_clock_out');
const whole = await staffCall('POST', `/time-clock/patrollers/${fay.id}/shifts`, {
  resortId: lodge.id, dutyType: 'patrol', clockInAt: hoursAgo(30), clockOutAt: hoursAgo(22),
});
const wholeBody = await body(whole);
ok('and can', whole.status === 201 && wholeBody.status === 'closed' && wholeBody.closeReason === 'admin', `${whole.status} ${wholeBody.closeReason}`);
const overlapping = await staffCall('POST', `/time-clock/patrollers/${fay.id}/shifts`, {
  resortId: summit.id, dutyType: 'patrol', clockInAt: hoursAgo(26), clockOutAt: hoursAgo(24),
});
const overlapBody = await overlapping.json();
ok('a shift overlapping another is refused (E7)', overlapping.status === 409 && overlapBody.code === 'overlaps'
   && overlapBody.details?.entry?.id === wholeBody.id, `${overlapping.status} ${overlapBody.code}`);
const removed = await staffCall('DELETE', `/time-clock/entries/${wholeBody.id}`);
ok('staff can remove a shift (E7)', removed.status === 204 && (await entriesOf(fay)).length === 0, String(removed.status));

const gus = await patroller('Gus');
const gusIn = ipadIn(gus, hoursAgo(6));
const gusDup = ipadIn(gus, hoursAgo(2), { resortId: summit.id });
await send(lodgeIpad, [gusIn]);
await send(summitIpad, [gusDup]);
const corrected = await staffCall('PATCH', `/time-clock/entries/${gusIn.id}`, { clockOutAt: hoursAgo(4) });
const gusEntries = await entriesOf(gus);
const kept = await eventOf(gusDup.id);
ok('a correction keeps a duplicate a duplicate (E26)',
   corrected.status === 200 && gusEntries.length === 1 && kept?.status === 'voided' && kept?.statusNote === 'kept_duplicate',
   `${gusEntries.length} ${kept?.status} ${kept?.statusNote}`);

// ─── R10: switching Time Clock off ───────────────────────────────────────────

const hal = await patroller('Hal');
const halIn = ipadIn(hal, hoursAgo(1));
await send(lodgeIpad, [halIn]);
const offSwitch = await staffCall('PATCH', '/modules/time_tracking', { enabled: false });
const halEntry = (await entriesOf(hal))[0];
ok('switching Time Clock off clocks everyone out (E18)',
   offSwitch.status === 200 && halEntry?.status === 'closed' && halEntry?.closeEventId === `admin-disable:${halIn.id}`,
   `${offSwitch.status} ${halEntry?.closeEventId}`);
const refused = await fetch(`${BASE}/orgs/${org.id}/time-clock/events`, {
  method: 'POST', headers: lodgeIpad.H, body: JSON.stringify({ events: [ipadIn(hal, hoursAgo(0.5))] }),
});
const me = await fetch(`${BASE}/devices/me`, { headers: lodgeIpad.H }).then(body);
ok('and iPads are refused, and told', refused.status === 403 && !JSON.stringify(me).includes('time_tracking'), String(refused.status));
await enable(true);

await cleanup();
await prisma.$disconnect();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exitCode = failures ? 1 : 0;
