// Printing what the iPad drew through the station's bridge (iOS Plan 26),
// against a running API and a real database.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-station-print.mjs
//
// The iPad sends the pages it drew; the bridge prints exactly those bytes. A
// raster drawn for settings the printer no longer has is refused, or fails at
// claim if the printer changed after it was queued. `queueTag: false` keeps a
// create from queueing a tag of its own.

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { smokeOrg } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

// ─── Fixtures ────────────────────────────────────────────────────────────────
const SEED = 'station-print-smoke';
const org = await smokeOrg(prisma);
const prior = await prisma.skiSwap.findMany({ where: { orgId: org.id, title: 'Station print swap' }, select: { id: true } });
for (const s of prior) { await prisma.printJob.deleteMany({ where: { swapId: s.id } }); await prisma.swapItem.deleteMany({ where: { swapId: s.id } }); }
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Station print swap' } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'Print station' } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: 'Print station printer' } });
await prisma.device.deleteMany({ where: { clientId: { startsWith: SEED } } });

const secret = 'station-print-secret';
const device = async (suffix, role) => prisma.device.create({
  data: { orgId: org.id, name: `Print ${suffix}`, clientId: `${SEED}-${suffix}`, secretHash: await argon2.hash(secret), role },
});
const bridge = await device('bridge', 'ski_swap.print_bridge');
const ipad = await device('ipad', 'ski_swap.staff_check_in');
const printer = await prisma.swapPrinter.create({
  data: { orgId: org.id, name: 'Print station printer', bluetoothName: 'M221-PRINT', model: 'm221', paperSize: '62x100', bridgeDeviceId: bridge.id },
});
const taken = new Set((await prisma.checkinStation.findMany({ where: { orgId: org.id }, select: { code: true } })).map((s) => s.code));
const station = await prisma.checkinStation.create({
  data: { orgId: org.id, name: 'Print station', code: [...'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'].find((c) => !taken.has(c)),
          attendantDeviceId: ipad.id, bridgeDeviceId: bridge.id },
});
const swap = await prisma.skiSwap.create({
  data: { orgId: org.id, slug: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title: 'Station print swap', squareCategoryId: 'smoke', skuPrefix: 'SPS', active: true, activeSkuPrefix: 'SPS' },
});

const tokenFor = async (clientId) => (await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret: secret }),
}).then(unwrap)).accessToken;
const B = { authorization: `Bearer ${await tokenFor(`${SEED}-bridge`)}`, 'content-type': 'application/json' };
const I = { authorization: `Bearer ${await tokenFor(`${SEED}-ipad`)}`, 'content-type': 'application/json' };

const heartbeat = () => fetch(`${BASE}/devices/me/print-jobs/claim?limit=0`, { method: 'POST', headers: B, body: JSON.stringify({ printerLink: 'ready' }) });
const claim = () => fetch(`${BASE}/devices/me/print-jobs/claim?limit=50&wait=0&payload=omit`, { method: 'POST', headers: B, body: '{}' }).then(unwrap);
const print = (body) => fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${station.id}/print`, { method: 'POST', headers: I, body: JSON.stringify(body) });

// 62 × 100 on an M221: the full 576-dot head, 800 rows less 16 feed rows.
const W = 576, H = 784, BYTES = (W / 8) * H;
const page = (seed) => { const b = Buffer.alloc(BYTES); for (let i = 0; i < BYTES; i++) b[i] = (i * 31 + seed) & 0xff; return b; };
const drawn = (pages, over = {}) => ({
  kind: 'item_tag', swapId: swap.id, copies: 1, model: 'm221', paperSize: '62x100', widthDots: W, heightDots: H,
  pages: pages.map((p) => p.toString('base64')), ...over,
});

// ─── The iPad can see the bridge ─────────────────────────────────────────────
await heartbeat();
const me = await fetch(`${BASE}/devices/me`, { headers: I }).then(unwrap);
ok('/devices/me says the bridge is online and its printer ready', me.station?.printBridge?.online === true && me.station.printBridge.printer?.ready === true,
  JSON.stringify({ online: me.station?.printBridge?.online, ready: me.station?.printBridge?.printer?.ready }));

// ─── Printed as sent ─────────────────────────────────────────────────────────
const sent = [page(1), page(2)];
const queued = await print(drawn(sent, { copies: 2 }));
const queuedBody = await unwrap(queued);
ok('two pages, two copies, queue four labels', queued.status === 202 && queuedBody.jobIds?.length === 4, `HTTP ${queued.status}`);

const got = await claim();
ok('one claim hands the bridge all four, in order', got.jobs?.map((j) => j.kind).join(',') === Array(4).fill('drawn_item_tag').join(',')
  && got.jobs.every((j) => j.widthBytes === W / 8 && j.rasterBytes === BYTES), got.jobs?.map((j) => `${j.kind}:${j.rasterBytes}`).join(' '));
let identical = true;
for (const [i, j] of (got.jobs ?? []).entries()) {
  const bytes = Buffer.from(await (await fetch(`${BASE}/devices/me/print-jobs/${j.id}/raster`, { headers: B })).arrayBuffer());
  if (!bytes.equals(sent[i % 2])) identical = false;
}
ok('the bridge downloads exactly the bytes the iPad drew', identical);
for (const j of got.jobs ?? []) await fetch(`${BASE}/devices/me/print-jobs/${j.id}/ack`, { method: 'POST', headers: B });
const kept = await prisma.printJob.count({ where: { id: { in: queuedBody.jobIds ?? [] }, raster: { not: null } } });
ok('once printed, the pages are not kept', kept === 0, `${kept} still stored`);

// ─── A long receipt fits ─────────────────────────────────────────────────────
const long = await print(drawn(Array.from({ length: 18 }, (_, i) => page(i)), { kind: 'receipt' }));
const longBody = await unwrap(long);
ok('an 18-page receipt (over a megabyte) is accepted', long.status === 202 && longBody.jobIds?.length === 18, `HTTP ${long.status}`);
await prisma.printJob.deleteMany({ where: { id: { in: longBody.jobIds ?? [] } } });

// ─── Refused, or dropped ─────────────────────────────────────────────────────
const stale = await print(drawn([page(3)], { paperSize: '50x30' }));
const staleBody = await stale.json();
ok('a raster drawn for other stock is refused', stale.status === 409 && staleBody.code === 'PRINTER_STOCK', `HTTP ${stale.status} ${staleBody.code}: ${staleBody.error}`);

const short = await print({ ...drawn([page(4)]), pages: [Buffer.alloc(100).toString('base64')] });
ok('a page of the wrong length is 400', short.status === 400, `HTTP ${short.status}`);

const changed = await unwrap(await print(drawn([page(5)])));
await prisma.swapPrinter.update({ where: { id: printer.id }, data: { paperSize: '50x30', model: 'm221' } });
const afterChange = await claim();
const failed = await prisma.printJob.findUnique({ where: { id: changed.jobIds[0] } });
ok('a label whose printer was re-set before the bridge took it fails rather than prints',
  (afterChange.jobs ?? []).length === 0 && failed.status === 'failed' && failed.raster === null, `${failed.status}: ${failed.lastError}`);
await prisma.swapPrinter.update({ where: { id: printer.id }, data: { paperSize: '62x100' } });

// ─── queueTag ────────────────────────────────────────────────────────────────
const create = (extra) => fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`, {
  method: 'POST', headers: I, body: JSON.stringify({ priceCents: 2500, quantity: 1, stationId: station.id, ...extra }),
}).then(unwrap);
const quiet = await create({ queueTag: false });
const loud = await create({});
const [quietJobs, loudJobs] = await Promise.all([
  prisma.printJob.count({ where: { itemId: quiet.id } }),
  prisma.printJob.count({ where: { itemId: loud.id } }),
]);
ok('queueTag: false queues no tag; omitted, a tag is queued as before', quietJobs === 0 && loudJobs > 0 && quiet.hasPrintedTag === false,
  `${quietJobs} vs ${loudJobs}`);

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.printJob.deleteMany({ where: { stationId: station.id } });
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.checkinStation.delete({ where: { id: station.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.swapPrinter.delete({ where: { id: printer.id } });
await prisma.device.deleteMany({ where: { clientId: { startsWith: SEED } } });
await prisma.$disconnect();

console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
