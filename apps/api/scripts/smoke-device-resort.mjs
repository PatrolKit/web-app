// Walks the resort binding of a time-clock terminal against a running API and
// real database: an admin places a tablet, the tablet reads where it stands,
// carries itself to another lodge, and is refused everything it should be.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-device-resort.mjs
//
// Sign-in endpoints are throttled to five attempts a minute, so back-to-back
// runs return 429 and look like a regression. Leave a minute between them.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const org = await smokeOrg(prisma);

// ─── Fixtures ────────────────────────────────────────────────────────────────
await prisma.orgModule.upsert({
  where: { orgId_moduleKey: { orgId: org.id, moduleKey: 'time_tracking' } },
  update: { enabled: true },
  create: { id: createId(), orgId: org.id, moduleKey: 'time_tracking', enabled: true, enabledAt: new Date() },
});
await prisma.device.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Resort smoke' } } });
await prisma.resort.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Smoke lodge' } } });

const north = await prisma.resort.create({
  data: { id: createId(), orgId: org.id, name: 'Smoke lodge North', timeZone: 'America/Denver', updatedAt: new Date() },
});
const south = await prisma.resort.create({
  data: { id: createId(), orgId: org.id, name: 'Smoke lodge South', timeZone: 'America/New_York', updatedAt: new Date() },
});
// Retired: a binding must not be able to name it, and one already pointing at
// it must read as unplaced.
const retired = await prisma.resort.create({
  data: {
    id: createId(), orgId: org.id, name: 'Smoke lodge Retired',
    timeZone: 'America/Denver', deletedAt: new Date(), updatedAt: new Date(),
  },
});

// A resort in an org this device has nothing to do with.
const otherOrg = await prisma.organization.upsert({
  where: { slug: 'patrolkit-smoke-other' },
  update: {},
  create: { id: createId(), name: 'Someone else', slug: 'patrolkit-smoke-other' },
});
await prisma.resort.deleteMany({ where: { orgId: otherOrg.id, name: 'Not yours' } });
const foreign = await prisma.resort.create({
  data: { id: createId(), orgId: otherOrg.id, name: 'Not yours', timeZone: 'America/Denver', updatedAt: new Date() },
});

const { user: staff } = await smokeStaff(prisma, org, ['time_tracking:manage', 'ski_swap:admin']);
const staffToken = await smokeSession(prisma, BASE, staff, unwrap);
const H = { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' };

// ─── An admin places a tablet at provision time ──────────────────────────────

const provisioned = await fetch(`${BASE}/orgs/${org.id}/devices`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ name: 'Resort smoke terminal', role: 'time_clock.terminal', resortId: north.id }),
}).then(unwrap);
ok('a terminal can be placed as it is provisioned', !!provisioned.id, provisioned.id);

const placed = await prisma.device.findUnique({ where: { id: provisioned.id } });
ok('and the binding is what was asked for', placed.resortId === north.id, placed.resortId);

const listed = await fetch(`${BASE}/orgs/${org.id}/devices`, { headers: H }).then(unwrap);
const row = listed.find((d) => d.id === provisioned.id);
ok('the admin list names the resort it is bound to',
   row?.resortId === north.id && row?.resortName === 'Smoke lodge North',
   `${row?.resortName}`);

// ─── The tablet reads where it stands ────────────────────────────────────────

const tok = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: provisioned.clientId, clientSecret: provisioned.clientSecret }),
}).then(unwrap);
const DH = { authorization: `Bearer ${tok.accessToken}`, 'content-type': 'application/json' };

const me = await fetch(`${BASE}/devices/me`, { headers: DH }).then(unwrap);
ok('the device is told its resort', me.resort?.id === north.id, JSON.stringify(me.resort));
// The nightly auto-close runs in resort-local time, so the zone has to arrive
// with the binding rather than after the first resort sync.
ok('and the time zone travels with it', me.resort?.timeZone === 'America/Denver', me.resort?.timeZone);

// ─── The tablet is carried to another lodge ──────────────────────────────────

const rebound = await fetch(`${BASE}/devices/me/resort`, {
  method: 'PATCH', headers: DH, body: JSON.stringify({ resortId: south.id }),
}).then(unwrap);
ok('a terminal can rebind itself', rebound.resort?.id === south.id, JSON.stringify(rebound.resort));
ok('and the answer already carries the new zone',
   rebound.resort?.timeZone === 'America/New_York', rebound.resort?.timeZone);

const afterRebind = await prisma.device.findUnique({ where: { id: provisioned.id } });
ok('the rebind is what the database holds', afterRebind.resortId === south.id, afterRebind.resortId);

// ─── What it may not do ──────────────────────────────────────────────────────

const crossOrg = await fetch(`${BASE}/devices/me/resort`, {
  method: 'PATCH', headers: DH, body: JSON.stringify({ resortId: foreign.id }),
});
ok("a device cannot bind to another org's resort", crossOrg.status === 404, String(crossOrg.status));

const toRetired = await fetch(`${BASE}/devices/me/resort`, {
  method: 'PATCH', headers: DH, body: JSON.stringify({ resortId: retired.id }),
});
ok('nor to a retired one', toRetired.status === 404, String(toRetired.status));

const stillSouth = await prisma.device.findUnique({ where: { id: provisioned.id } });
ok('and a refused rebind changes nothing', stillSouth.resortId === south.id, stillSouth.resortId);

// A print bridge has no resort to change.
const bridge = await fetch(`${BASE}/orgs/${org.id}/devices`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ role: 'ski_swap.print_bridge' }),
}).then(unwrap);
await prisma.device.update({ where: { id: bridge.id }, data: { name: 'Resort smoke bridge' } });

const bridgeTok = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: bridge.clientId, clientSecret: bridge.clientSecret }),
}).then(unwrap);
const bridgeRebind = await fetch(`${BASE}/devices/me/resort`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${bridgeTok.accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ resortId: north.id }),
});
ok('a print bridge is refused the route entirely', bridgeRebind.status === 403, String(bridgeRebind.status));

const bridgeBind = await fetch(`${BASE}/orgs/${org.id}/devices/${bridge.id}/resort`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ resortId: north.id }),
});
ok('and staff cannot place one either', bridgeBind.status === 400, String(bridgeBind.status));

const unauth = await fetch(`${BASE}/devices/me/resort`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ resortId: north.id }),
});
ok('an unauthenticated rebind is refused', unauth.status === 401, String(unauth.status));

// ─── A resort retired underneath a bound device ──────────────────────────────

await prisma.resort.update({ where: { id: south.id }, data: { deletedAt: new Date() } });
const orphaned = await fetch(`${BASE}/devices/me`, { headers: DH }).then(unwrap);
// The tablet is genuinely standing somewhere the org no longer patrols, and
// should say so rather than name a resort nobody can act on.
ok('a retired resort reads as unplaced', orphaned.resort === null, JSON.stringify(orphaned.resort));

const orphanRow = await fetch(`${BASE}/orgs/${org.id}/devices`, { headers: H })
  .then(unwrap).then((all) => all.find((d) => d.id === provisioned.id));
ok('and the admin list agrees', orphanRow?.resortId === null, JSON.stringify(orphanRow?.resortName));

// ─── Staff unbind ────────────────────────────────────────────────────────────

await prisma.resort.update({ where: { id: south.id }, data: { deletedAt: null } });
const unbound = await fetch(`${BASE}/orgs/${org.id}/devices/${provisioned.id}/resort`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ resortId: null }),
});
ok('staff can take a tablet out of service', unbound.status === 200, String(unbound.status));

const afterUnbind = await prisma.device.findUnique({ where: { id: provisioned.id } });
ok('which unbinds it without revoking it',
   afterUnbind.resortId === null && afterUnbind.clientId === provisioned.clientId);

// ─── Deleting a resort releases the hardware ─────────────────────────────────

await fetch(`${BASE}/orgs/${org.id}/devices/${provisioned.id}/resort`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ resortId: north.id }),
});
await prisma.resort.delete({ where: { id: north.id } });
const released = await prisma.device.findUnique({ where: { id: provisioned.id } });
// SetNull on the foreign key: retiring a lodge must not delete the tablet
// standing in it.
ok('deleting a resort releases its devices rather than taking them with it',
   released !== null && released.resortId === null, JSON.stringify(released?.resortId));

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.device.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Resort smoke' } } });
await prisma.resort.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Smoke lodge' } } });
await prisma.resort.deleteMany({ where: { orgId: otherOrg.id } });
await prisma.organization.delete({ where: { id: otherOrg.id } });
await prisma.$disconnect();
