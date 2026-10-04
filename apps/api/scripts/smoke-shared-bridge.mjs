// One print bridge for several staffed stations (Plan 27), against a running
// API and a real database.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-shared-bridge.mjs
//
// The claim's ordering is hand-written SQL — first queued first, each batch
// whole — and only MySQL can say whether two batches from two counters come out
// that way. The binding rules are checked over HTTP as staff meet them.

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

// ─── Fixtures ────────────────────────────────────────────────────────────────
const SEED = 'shared-bridge-smoke';
const org = await smokeOrg(prisma);
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Shared bridge swap' } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Shared ' } } });
await prisma.device.deleteMany({ where: { clientId: { startsWith: SEED } } });

const secret = 'shared-bridge-secret';
const device = async (suffix, role) => prisma.device.create({
  data: { orgId: org.id, name: `Shared ${suffix}`, clientId: `${SEED}-${suffix}`, secretHash: await argon2.hash(secret), role },
});
const bridge = await device('bridge', 'ski_swap.print_bridge');
const ipadA = await device('ipad-a', 'ski_swap.staff_check_in');
const ipadB = await device('ipad-b', 'ski_swap.staff_check_in');

// Codes are unique within an org, deleted stations included, and the other
// smoke scripts hold some — so take whichever are free.
const taken = new Set((await prisma.checkinStation.findMany({ where: { orgId: org.id }, select: { code: true } })).map((s) => s.code));
const free = [...'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'].filter((c) => !taken.has(c));
const stationA = await prisma.checkinStation.create({ data: { orgId: org.id, name: 'Shared A', code: free[0] } });
const stationB = await prisma.checkinStation.create({ data: { orgId: org.id, name: 'Shared B', code: free[1] } });
const selfService = await prisma.checkinStation.create({ data: { orgId: org.id, name: 'Shared self-service', code: free[2] } });

// Two tags an item, so each counter's save is a batch of more than one.
const swap = await prisma.skiSwap.create({
  data: { orgId: org.id, slug: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title: 'Shared bridge swap', squareCategoryId: 'smoke', skuPrefix: 'SHB', active: true, activeSkuPrefix: 'SHB', labelsPerItem: 2 },
});

const { user } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const staff = await smokeSession(prisma, BASE, user, unwrap);
const S = { authorization: `Bearer ${staff}`, 'content-type': 'application/json' };
const patchStation = (id, body) =>
  fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${id}`, { method: 'PATCH', headers: S, body: JSON.stringify(body) });

// ─── Binding ─────────────────────────────────────────────────────────────────
await patchStation(stationA.id, { attendantDeviceId: ipadA.id });
await patchStation(stationB.id, { attendantDeviceId: ipadB.id });
const bindA = await patchStation(stationA.id, { bridgeDeviceId: bridge.id });
const bindB = await patchStation(stationB.id, { bridgeDeviceId: bridge.id });
const bodyB = await unwrap(bindB);
ok('two staffed stations share one bridge', bindA.status === 200 && bindB.status === 200,
  `A ${bindA.status}, B ${bindB.status}`);
ok('...and each says who it shares with', JSON.stringify(bodyB.bridgeSharedWith) === '["Shared A"]',
  JSON.stringify(bodyB.bridgeSharedWith));

const selfBind = await patchStation(selfService.id, { bridgeDeviceId: bridge.id });
ok('a self-service station is refused a shared bridge', selfBind.status === 409,
  `HTTP ${selfBind.status} ${JSON.stringify(await selfBind.json()).slice(0, 160)}`);

const unstaff = await patchStation(stationB.id, { attendantDeviceId: null });
ok('taking the iPad from a station that shares its bridge is refused', unstaff.status === 409, `HTTP ${unstaff.status}`);

// ─── Two counters, one printer ───────────────────────────────────────────────
const addItem = (stationId, priceCents) =>
  fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`, {
    method: 'POST', headers: S, body: JSON.stringify({ priceCents, quantity: 1, stationId }),
  }).then(unwrap);
const itemA = await addItem(stationA.id, 1000);
const itemB = await addItem(stationB.id, 2000);
ok('each counter queued a batch of two', (await prisma.printJob.count({ where: { stationId: { in: [stationA.id, stationB.id] } } })) === 4);

const token = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: `${SEED}-bridge`, clientSecret: secret }),
}).then(unwrap);
const B = { authorization: `Bearer ${token.accessToken}`, 'content-type': 'application/json' };
const claim = await fetch(`${BASE}/devices/me/print-jobs/claim?limit=10&wait=0&payload=omit`, { method: 'POST', headers: B, body: '{}' }).then(unwrap);

ok('the bridge is told every station it serves',
  JSON.stringify([...claim.stationIds].sort()) === JSON.stringify([stationA.id, stationB.id].sort()) &&
    claim.stationIds.includes(claim.stationId),
  JSON.stringify({ stationId: claim.stationId, stationIds: claim.stationIds }));

const jobs = await prisma.printJob.findMany({ where: { id: { in: claim.jobs.map((j) => j.id) } }, select: { id: true, itemId: true } });
const order = claim.jobs.map((j) => jobs.find((x) => x.id === j.id)?.itemId === itemA.id ? 'A' : 'B').join('');
ok('one claim takes both counters’ tags, first batch first and each batch whole', order === 'AABB', order);

for (const j of claim.jobs) await fetch(`${BASE}/devices/me/print-jobs/${j.id}/ack`, { method: 'POST', headers: B });
const printed = await prisma.printJob.count({ where: { stationId: { in: [stationA.id, stationB.id] }, status: 'printed' } });
ok('the bridge acknowledges jobs from both stations', printed === 4, `${printed} printed`);

ok('the tags carry their counter’s letter in the number',
  itemA.sku.includes(`-${stationA.code}-`) && itemB.sku.includes(`-${stationB.code}-`), `${itemA.sku}, ${itemB.sku}`);

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.printJob.deleteMany({ where: { stationId: { in: [stationA.id, stationB.id, selfService.id] } } });
await prisma.checkinStation.deleteMany({ where: { id: { in: [stationA.id, stationB.id, selfService.id] } } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.device.deleteMany({ where: { clientId: { startsWith: SEED } } });
await prisma.$disconnect();

console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
