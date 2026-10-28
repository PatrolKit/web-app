// The roster is the members (Plan 57): people are added on Members, by form and
// by file, every member is on the time clock, and a member with no NSP ID
// clocks in with a PIN they chose.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-members-clock.mjs
//
// Everything lives in the smoke org and is removed on the way out. People are
// global, so they carry @patrolkit.invalid addresses (or none, and an NSP ID
// starting MCSMOKE) and are deleted by them.

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

const PREFIX = 'Members clock smoke';
const MAIL = (n) => `members-clock-${n}@patrolkit.invalid`;
const STAMP = String(Date.now() % 100000);
const NSP = (n) => `MCSMOKE${STAMP}${n}`;

const org = await smokeOrg(prisma);

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { OR: [{ email: { startsWith: 'members-clock-' } }, { nspId: { startsWith: 'MCSMOKE' } }] },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  const profiles = await prisma.patrollerProfile.findMany({ where: { membership: { userId: { in: ids } } }, select: { id: true } });
  const pids = profiles.map((p) => p.id);
  await prisma.timeClockEvent.deleteMany({ where: { patrollerId: { in: pids } } });
  await prisma.timeEntry.deleteMany({ where: { patrollerId: { in: pids } } });
  await prisma.patrollerProfile.deleteMany({ where: { id: { in: pids } } });
  await prisma.sellerProfile.deleteMany({ where: { membership: { userId: { in: ids } } } });
  await prisma.contactChallenge.deleteMany({ where: { userId: { in: ids } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.membership.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.device.deleteMany({ where: { orgId: org.id, name: { startsWith: PREFIX } } });
  await prisma.resort.deleteMany({ where: { orgId: org.id, name: { startsWith: PREFIX } } });
  await prisma.auditLog.deleteMany({ where: { orgId: org.id, action: { startsWith: 'member.' } } });
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

const { user: staff } = await smokeStaff(prisma, org, [
  'users:read', 'users:invite', 'users:import', 'users:manage', 'time_tracking:report', 'time_tracking:manage', 'ski_swap:admin',
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

const add = (body) => fetch(`${BASE}/orgs/${org.id}/members`, {
  method: 'POST', headers: H, body: JSON.stringify({ permissions: [], ...body }),
});
const update = (userId, body) => fetch(`${BASE}/orgs/${org.id}/members/${userId}`, {
  method: 'PATCH', headers: H, body: JSON.stringify(body),
});
const members = () => fetch(`${BASE}/orgs/${org.id}/members`, { headers: H }).then(unwrap);
const roster = () => fetch(`${BASE}/orgs/${org.id}/time-clock/patrollers`, { headers: D }).then(unwrap);
const recordOf = async (m) => prisma.patrollerProfile.findUnique({ where: { membershipId: m.membershipId } });

// ─── D4: adding people, contact optional ────────────────────────────────────

const tomRes = await add({ firstName: 'Tom', lastName: 'Contactless', nspId: NSP(1), patrolLevel: 'Basic' });
const tom = await unwrap(tomRes);
ok('a member can be added with a name and an NSP ID alone', tomRes.status === 201 && tom.nspId === NSP(1) && !tom.email,
   `${tomRes.status} ${JSON.stringify(tom).slice(0, 120)}`);
ok('and can clock in', tom.canClockIn === true);

const pat = await unwrap(await add({ email: MAIL('pat'), firstName: 'Pat', lastName: 'Pinless' }));
ok('a member with an email and no NSP ID cannot clock in yet', pat.canClockIn === false && pat.clockPinSet === false);

const nobody = await add({ firstName: 'Nobody' });
ok('a member with nothing to tell them apart by is refused', nobody.status === 400, String(nobody.status));
const unnamed = await add({ nspId: NSP(9) });
ok('and so is one with no email and no name', unnamed.status === 400, String(unnamed.status));

// ─── D1: every member is on the clock, never a seller alone ─────────────────

let r = await roster();
const rosterTom = r.find((p) => p.nspId === NSP(1));
ok('the terminal roster lists every member, with no contact details',
   !!rosterTom && r.every((p) => !('email' in p) && !('phone' in p)), `${r.length} rows`);
ok('including the member who cannot clock in yet', r.some((p) => p.firstName === 'Pat' && p.lastName === 'Pinless'));

const seller = await prisma.user.create({ data: { id: createId(), email: MAIL('seller'), firstName: 'Sam', lastName: 'SellerOnly' } });
const sellerMembership = await prisma.membership.create({ data: { id: createId(), userId: seller.id, orgId: org.id, updatedAt: new Date() } });
await prisma.sellerProfile.create({ data: { id: randomUUID(), membershipId: sellerMembership.id, updatedAt: new Date() } });
r = await roster();
ok('someone who is only a seller is not on it', !r.some((p) => p.lastName === 'SellerOnly'));
ok('nor on Members', !(await members()).some((m) => m.userId === seller.id));

// D2: a member who then sells at the swap stays a member.
await prisma.sellerProfile.create({ data: { id: randomUUID(), membershipId: tom.membershipId, updatedAt: new Date() } });
ok('a member who starts selling at the swap stays a member', (await members()).some((m) => m.userId === tom.userId));
ok('and stays on the clock', (await roster()).some((p) => p.nspId === NSP(1) && p.active));

// ─── D7, D8: PINs ───────────────────────────────────────────────────────────

const patUser = await prisma.user.findUnique({ where: { id: pat.userId } });
const PH = { authorization: `Bearer ${await smokeSession(prisma, BASE, patUser, unwrap)}`, 'content-type': 'application/json' };
const setPin = (h, pin) => fetch(`${BASE}/me/orgs/${org.id}/clock-pin`, { method: 'PUT', headers: h, body: JSON.stringify({ pin }) });

const mine = await fetch(`${BASE}/me/clock`, { headers: PH }).then(unwrap);
const here = mine.orgs?.find((o) => o.orgId === org.id);
ok('My account says how they clock in here', here && here.nspId === null && here.clockPinSet === false && here.timeTracking === true,
   JSON.stringify(here));
const short = await setPin(PH, '1234');
ok('a PIN is six digits', short.status === 400, String(short.status));
const pin = String(100000 + (Date.now() % 800000));
const set = await setPin(PH, pin);
ok('a member with no NSP ID can choose a PIN', set.status === 200, String(set.status));
const patNow = (await members()).find((m) => m.userId === pat.userId);
ok('and then can clock in, without staff ever seeing it', patNow?.canClockIn === true && patNow?.clockPinSet === true && !JSON.stringify(patNow).includes(pin));
const rosterPat = (await roster()).find((p) => p.firstName === 'Pat' && p.lastName === 'Pinless');
ok('the terminal gets the PIN to verify offline', rosterPat?.clockPin === pin, String(rosterPat?.clockPin));
ok("and nobody's NSP ID is sent as a PIN", (await roster()).find((p) => p.nspId === NSP(1))?.clockPin === null);
const staffRoster = await fetch(`${BASE}/orgs/${org.id}/time-clock/patrollers`, { headers: H }).then(unwrap);
ok("staff's roster never carries a PIN", staffRoster.every((p) => !('clockPin' in p)));

const lee = await unwrap(await add({ email: MAIL('lee'), firstName: 'Lee', lastName: 'Second' }));
const LH = { authorization: `Bearer ${await smokeSession(prisma, BASE, await prisma.user.findUnique({ where: { id: lee.userId } }), unwrap)}`, 'content-type': 'application/json' };
const taken = await setPin(LH, pin);
ok("a PIN someone else holds is refused, without saying whose", taken.status === 400 && !(await taken.text()).includes('Pat'), String(taken.status));
// Tom has no email to sign in with; give him one to test the NSP-holder refusal.
await update(tom.userId, { email: MAIL('tom') });
const tomSession = { authorization: `Bearer ${await smokeSession(prisma, BASE, await prisma.user.findUnique({ where: { id: tom.userId } }), unwrap)}`, 'content-type': 'application/json' };
const tomPin = await setPin(tomSession, '246810');
ok('someone with an NSP ID clocks in with it, and is refused a PIN', tomPin.status === 400, String(tomPin.status));

const leeNsp = await update(lee.userId, { nspId: pin });
const patAfter = (await members()).find((m) => m.userId === pat.userId);
ok("an NSP ID equal to someone's PIN takes it, and their PIN is cleared (D8)",
   leeNsp.status === 200 && patAfter?.clockPinSet === false && patAfter?.canClockIn === false, `${leeNsp.status} ${JSON.stringify(patAfter?.clockPinSet)}`);
await setPin(PH, String(Number(pin) + 1));
const cleared = await update(pat.userId, { clearClockPin: true });
ok('a members manager can clear a forgotten PIN', cleared.status === 200 && (await unwrap(cleared)).clockPinSet === false);

// ─── D5: inactive, and removal, take someone off the clock ──────────────────

const tomRecord = await recordOf(tom);
await fetch(`${BASE}/orgs/${org.id}/time-clock/events`, {
  method: 'POST', headers: D,
  body: JSON.stringify({ events: [{ id: randomUUID(), resortId: lodge.id, patrollerId: tomRecord.id, type: 'clock_in', dutyType: 'patrol', occurredAt: new Date(Date.now() - 3600_000).toISOString() }] }),
});
const clockedIn = (await members()).find((m) => m.userId === tom.userId);
ok('Members shows who is on entry', clockedIn?.clockedIn?.resortName === `${PREFIX} lodge`, JSON.stringify(clockedIn?.clockedIn));
const inactive = await update(tom.userId, { inactive: true });
const tomEntry = await prisma.timeEntry.findFirst({ where: { patrollerId: tomRecord.id }, orderBy: { clockInAt: 'desc' } });
ok('making an on-entry member inactive clocks them out', inactive.status === 200 && tomEntry?.status === 'closed' && tomEntry?.closeReason === 'admin',
   `${inactive.status} ${tomEntry?.status}/${tomEntry?.closeReason}`);
ok('and takes them off the clock, still a member', (await roster()).find((p) => p.nspId === NSP(1))?.active === false
   && (await members()).some((m) => m.userId === tom.userId && m.inactive));
await update(tom.userId, { inactive: false });
ok('switching it back puts them on again', (await roster()).find((p) => p.nspId === NSP(1))?.active === true);

const removed = await fetch(`${BASE}/orgs/${org.id}/members/${lee.userId}`, { method: 'DELETE', headers: H });
ok('a removed member is a tombstone on the roster', removed.status === 200
   && !!(await fetch(`${BASE}/orgs/${org.id}/time-clock/patrollers?updatedSince=${new Date(Date.now() - 60_000).toISOString()}`, { headers: D }).then(unwrap))
     .find((p) => p.nspId === pin)?.deletedAt);

// ─── D10: one import ────────────────────────────────────────────────────────

const csv = [
  'First,Last,E-mail,NSP Number,Level,Inactive',
  `Ann,Imported,${MAIL('ann')},${NSP(2)},Senior,`,
  `Ben,Contactless,,${NSP(3)},Basic,yes`,
  'Cal,NoIdentity,,,,',
  `Tom,Contactless,,${NSP(1)},Patroller,`,
].join('\n');
const form = new FormData();
form.append('file', new Blob([csv], { type: 'text/csv' }), 'roster.csv');
const parsed = await fetch(`${BASE}/orgs/${org.id}/members/import/parse`, {
  method: 'POST', headers: { authorization: H.authorization }, body: form,
}).then(unwrap);
ok('an import guesses the NSP export\'s columns', parsed.mapping?.nspId === 'NSP Number' && parsed.mapping?.email === 'E-mail'
   && parsed.mapping?.patrolLevel === 'Level' && parsed.totalRows === 4, JSON.stringify(parsed.mapping));
const rows = parsed.rows.map((row) => Object.fromEntries(
  Object.entries(parsed.mapping).map(([field, col]) => [field, col ? row[col] ?? null : null]),
));
const outcomes = await fetch(`${BASE}/orgs/${org.id}/members/import`, {
  method: 'POST', headers: H, body: JSON.stringify({ rows, strategy: 'overwrite', sendInvites: false }),
}).then(unwrap);
ok('it adds people with or without contact, refuses a row with nothing, and updates an existing member',
   JSON.stringify(outcomes.map((o) => o.outcome)) === JSON.stringify(['created', 'created', 'error', 'updated']),
   JSON.stringify(outcomes.map((o) => [o.outcome, o.error])));
const after = await members();
ok('an imported inactive member is inactive', after.find((m) => m.nspId === NSP(3))?.inactive === true);
ok('and overwrite updated the existing one', after.find((m) => m.userId === tom.userId)?.patrolLevel === 'Patroller');

await cleanup();
await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
