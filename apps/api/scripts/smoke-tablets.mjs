// Plan 56: one iPad for Ski Swap and Time Clock, against a running API and
// real database. An org admin adds a tablet, the tablet reports its mode and
// reaches both modules, a Ski Swap admin puts it at a station, and everyone is
// refused what they should be.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-tablets.mjs
//
// Sign-in endpoints are throttled to five attempts a minute, so back-to-back
// runs return 429 and look like a regression. Leave a minute between them.

import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const PREFIX = 'Tablet smoke';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
let failed = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

const org = await smokeOrg(prisma);

// ─── Fixtures ────────────────────────────────────────────────────────────────
for (const moduleKey of ['ski_swap', 'time_tracking']) {
  await prisma.orgModule.upsert({
    where: { orgId_moduleKey: { orgId: org.id, moduleKey } },
    update: { enabled: true },
    create: { id: createId(), orgId: org.id, moduleKey, enabled: true, enabledAt: new Date() },
  });
}
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: { startsWith: PREFIX } } });
await prisma.device.deleteMany({ where: { orgId: org.id, name: { startsWith: PREFIX } } });
const lodge = await prisma.resort.findFirst({ where: { orgId: org.id, deletedAt: null } })
  ?? await prisma.resort.create({ data: { id: createId(), orgId: org.id, name: `${PREFIX} lodge`, timeZone: 'America/Denver', updatedAt: new Date() } });
const pinBefore = (await prisma.organization.findUnique({ where: { id: org.id } })).tabletPin;

const { user: staff } = await smokeStaff(prisma, org, ['org:manage', 'ski_swap:admin', 'ski_swap:report']);
const staffToken = await smokeSession(prisma, BASE, staff, unwrap);
const H = { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' };
const api = (path, init = {}) => fetch(`${BASE}/orgs/${org.id}${path}`, { headers: H, ...init });
const json = (method, body) => ({ method, body: JSON.stringify(body) });

async function deviceHeaders(made) {
  const tok = await fetch(`${BASE}/auth/device/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: made.clientId, clientSecret: made.clientSecret }),
  }).then(unwrap);
  return { authorization: `Bearer ${tok.accessToken}`, 'content-type': 'application/json' };
}

// ─── An org admin adds a tablet ──────────────────────────────────────────────

const tablet = await api('/devices', json('POST', { name: `${PREFIX} 1`, role: 'org.tablet' })).then(unwrap);
ok('an org admin provisions a tablet', tablet.role === 'org.tablet' && !!tablet.clientSecret, tablet.role);

const renamed = await api(`/devices/${tablet.id}`, json('PATCH', { name: `${PREFIX} iPad A` })).then(unwrap);
ok('and renames it', renamed.name === `${PREFIX} iPad A`, renamed.name);

const pinSet = await api('/tablets/pin', json('PUT', { devicePin: '4821' })).then(unwrap);
ok('sets the org’s tablet PIN', pinSet.devicePin === '4821', JSON.stringify(pinSet));

// ─── The tablet ──────────────────────────────────────────────────────────────

const TH = await deviceHeaders(tablet);
const me = await fetch(`${BASE}/devices/me`, { headers: { ...TH, 'x-app-mode': 'ski_swap/check_in', 'x-app-version': '2.0.0', 'x-app-build': '200' } }).then(unwrap);
ok('the tablet is offered both modules', JSON.stringify(me.modules) === JSON.stringify(['ski_swap', 'time_tracking']), JSON.stringify(me.modules));
ok('and reads the PIN from /devices/me', me.tabletPin === '4821', me.tabletPin);
ok('its mode is recorded', (await prisma.device.findUnique({ where: { id: tablet.id } })).appMode === 'ski_swap/check_in');

const swaps = await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps`, { headers: TH });
ok('it reaches Ski Swap', swaps.status === 200, String(swaps.status));
const entries = await fetch(`${BASE}/orgs/${org.id}/time-clock/entries?walk=true`, { headers: TH });
ok('and Time Clock', entries.status === 200, String(entries.status));

const event = { id: randomUUID(), resortId: lodge.id, patrollerId: 'no-such-patroller', type: 'clock_in', dutyType: 'patrol', occurredAt: new Date().toISOString() };
const clocked = await fetch(`${BASE}/orgs/${org.id}/time-clock/events`, { method: 'POST', headers: TH, body: JSON.stringify({ events: [event] }) });
ok('it may submit clock events', clocked.status === 200, String(clocked.status));

for (const [label, path] of [['Ski Swap’s', 'ski-swap'], ['Time Clock’s', 'time-clock']]) {
  const pin = await fetch(`${BASE}/orgs/${org.id}/${path}/settings/device-pin`, { headers: TH }).then(unwrap);
  ok(`${label} PIN route gives an older build the same PIN`, pin.devicePin === '4821', JSON.stringify(pin));
}

await fetch(`${BASE}/devices/me`, { headers: TH });
ok('a request without a mode leaves the last report', (await prisma.device.findUnique({ where: { id: tablet.id } })).appMode === 'ski_swap/check_in');

const placedHere = await fetch(`${BASE}/devices/me/resort`, { method: 'PATCH', headers: TH, body: JSON.stringify({ resortId: lodge.id }) }).then(unwrap);
ok('it places itself at a resort, on the iPad', placedHere.resort?.id === lodge.id, JSON.stringify(placedHere.resort));
const adminPlaces = await api(`/devices/${tablet.id}/resort`, json('PATCH', { resortId: null }));
ok('the web can’t place a tablet', adminPlaces.status === 400, String(adminPlaces.status));

// ─── A print bridge clocks nobody in ─────────────────────────────────────────

const bridge = await api('/devices', json('POST', { name: `${PREFIX} bridge`, role: 'ski_swap.print_bridge' })).then(unwrap);
const BH = await deviceHeaders(bridge);
const bridgeClock = await fetch(`${BASE}/orgs/${org.id}/time-clock/events`, { method: 'POST', headers: BH, body: JSON.stringify({ events: [{ ...event, id: randomUUID() }] }) });
ok('a print bridge’s clock events are refused', bridgeClock.status === 403, String(bridgeClock.status));
await prisma.device.delete({ where: { id: bridge.id } });

// ─── Stations ────────────────────────────────────────────────────────────────

const s1 = await api('/ski-swap/stations', json('POST', { name: `${PREFIX} station 1`, kind: 'staffed' })).then(unwrap);
ok('a staffed station starts without a tablet', s1.kind === 'staffed' && s1.attendantDeviceId === null, JSON.stringify([s1.kind, s1.attendantDeviceId]));

const options = await api('/ski-swap/stations/tablet-options').then(unwrap);
const option = options.find?.((o) => o.id === tablet.id);
ok('the tablet is offered for it, with its mode', option?.appMode === 'ski_swap/check_in', JSON.stringify(option));
ok('and no credentials', option && !('clientId' in option) && !('clientSecret' in option));

const attached = await api(`/ski-swap/stations/${s1.id}`, json('PATCH', { attendantDeviceId: tablet.id })).then(unwrap);
ok('a Ski Swap admin puts it at the station', attached.attendantDeviceId === tablet.id && attached.attendantMode === 'ski_swap/check_in', JSON.stringify([attached.attendantDeviceId, attached.attendantMode]));
const meStation = await fetch(`${BASE}/devices/me`, { headers: TH }).then(unwrap);
ok('and the tablet learns its station', meStation.station?.id === s1.id, JSON.stringify(meStation.station));

const s2 = await api('/ski-swap/stations', json('POST', { name: `${PREFIX} station 2`, kind: 'staffed' })).then(unwrap);
const inUse = await api(`/ski-swap/stations/${s2.id}`, json('PATCH', { attendantDeviceId: tablet.id }));
const inUseBody = await inUse.json();
ok('a tablet in use elsewhere is refused, naming that station',
   inUse.status === 409 && JSON.stringify(inUseBody).includes('TABLET_IN_USE') && JSON.stringify(inUseBody).includes(`${PREFIX} station 1`),
   `${inUse.status} ${JSON.stringify(inUseBody).slice(0, 200)}`);

const moved = await api(`/ski-swap/stations/${s2.id}`, json('PATCH', { attendantDeviceId: tablet.id, takeTablet: true })).then(unwrap);
const left = (await api('/ski-swap/stations').then(unwrap)).find((s) => s.id === s1.id);
ok('moving it leaves the first station staffed and waiting',
   moved.attendantDeviceId === tablet.id && left?.kind === 'staffed' && left?.attendantDeviceId === null,
   JSON.stringify([moved.attendantDeviceId, left?.kind, left?.attendantDeviceId]));

const list = await api('/tablets').then(unwrap);
const row = list.find?.((d) => d.id === tablet.id);
ok('Tablets lists it with its station, mode, resort and app',
   row?.stationName === `${PREFIX} station 2` && row?.appMode === 'ski_swap/check_in' && row?.resortId === lodge.id && row?.appBuild === '200',
   JSON.stringify(row && [row.stationName, row.appMode, row.resortName, row.appVersion, row.appBuild]));

const selfService = await api(`/ski-swap/stations/${s2.id}`, json('PATCH', { kind: 'self_service' })).then(unwrap);
ok('a station turned self-service lets its tablet go', selfService.kind === 'self_service' && selfService.attendantDeviceId === null, JSON.stringify([selfService.kind, selfService.attendantDeviceId]));

// ─── Who may ─────────────────────────────────────────────────────────────────

await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:report']);
const tabletsAsSwapAdmin = await api('/tablets');
ok('a Ski Swap admin who isn’t an org admin can’t open Tablets', tabletsAsSwapAdmin.status === 403, String(tabletsAsSwapAdmin.status));
const provisionAsSwapAdmin = await api('/devices', json('POST', { name: `${PREFIX} 2`, role: 'org.tablet' }));
ok('nor add a tablet', provisionAsSwapAdmin.status === 403, String(provisionAsSwapAdmin.status));
const optionsAsSwapAdmin = await api('/ski-swap/stations/tablet-options');
ok('but can choose one for a station', optionsAsSwapAdmin.status === 200, String(optionsAsSwapAdmin.status));

// ─── Clean up ────────────────────────────────────────────────────────────────

await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: { startsWith: PREFIX } } });
await prisma.device.deleteMany({ where: { orgId: org.id, name: { startsWith: PREFIX } } });
await prisma.timeClockEvent.deleteMany({ where: { id: event.id } });
await prisma.organization.update({ where: { id: org.id }, data: { tabletPin: pinBefore } });
await prisma.$disconnect();

console.log(failed ? `\n${failed} assertion(s) failed` : '\nAll assertions passed');
process.exit(failed ? 1 : 0);
