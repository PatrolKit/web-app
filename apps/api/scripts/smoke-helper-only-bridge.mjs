// A print bridge loaded with 25 × 67 helper labels (Plan 28), against a running
// API and a real database.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-helper-only-bridge.mjs
//
// The station's iPad sends the helper stickers it drew through the print
// endpoint (iOS Plan 26). Success is a bridge that is online, a printer that is
// online, and the pair queued; anything else is refused at once with a reason,
// and a pair not taken within a minute is dropped. Such a bridge prints helper
// labels and nothing else.

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
const SEED = 'helper-only-bridge-smoke';
const org = await smokeOrg(prisma);
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Helper labels swap' } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'Helper station' } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: 'Helper printer' } });
await prisma.device.deleteMany({ where: { clientId: { startsWith: SEED } } });

const secret = 'helper-labels-secret';
const device = async (suffix, role) => prisma.device.create({
  data: { orgId: org.id, name: `Helper ${suffix}`, clientId: `${SEED}-${suffix}`, secretHash: await argon2.hash(secret), role },
});
const bridge = await device('bridge', 'ski_swap.print_bridge');
const ipad = await device('ipad', 'ski_swap.staff_check_in');
const printer = await prisma.swapPrinter.create({
  data: { orgId: org.id, name: 'Helper printer', bluetoothName: 'M221-HELPER', model: 'm221', paperSize: '25x67', bridgeDeviceId: bridge.id },
});
const taken = new Set((await prisma.checkinStation.findMany({ where: { orgId: org.id }, select: { code: true } })).map((s) => s.code));
const code = [...'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'].find((c) => !taken.has(c));
const station = await prisma.checkinStation.create({
  data: { orgId: org.id, name: 'Helper station', code, attendantDeviceId: ipad.id, bridgeDeviceId: bridge.id },
});
const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, title: 'Helper labels swap', squareCategoryId: 'smoke', skuPrefix: 'HLP', active: true, activeSkuPrefix: 'HLP',
    legacyTicketsEnabled: true, legacyTicketsOnly: true, printLegacyHelperLabels: true,
  },
});

const tokenFor = async (clientId) => (await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret: secret }),
}).then(unwrap)).accessToken;
const B = { authorization: `Bearer ${await tokenFor(`${SEED}-bridge`)}`, 'content-type': 'application/json' };
const I = { authorization: `Bearer ${await tokenFor(`${SEED}-ipad`)}`, 'content-type': 'application/json' };

// The bridge checks in and reports its printer, as it does on every claim.
const heartbeat = () => fetch(`${BASE}/devices/me/print-jobs/claim?limit=0`, {
  method: 'POST', headers: B, body: JSON.stringify({ printerLink: 'ready' }),
});
const claim = () => fetch(`${BASE}/devices/me/print-jobs/claim?limit=10&wait=0&payload=omit`, {
  method: 'POST', headers: B, body: '{}',
}).then(unwrap);
// 25 × 67 on an M221: the full 576-dot head, 536 rows less 16 feed rows.
const sticker = (fill) => Buffer.alloc((576 / 8) * 520, fill).toString('base64');
const ask = (body = {}) => fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${station.id}/print`, {
  method: 'POST', headers: I,
  body: JSON.stringify({
    kind: 'helper_labels', swapId: swap.id, copies: 1, model: 'm221', paperSize: '25x67',
    widthDots: 576, heightDots: 520, pages: [sticker(1), sticker(2)], ...body,
  }),
});

// ─── What the iPad knows before it asks ──────────────────────────────────────
// As an iPad on a build that sends only its default User-Agent.
const me = await fetch(`${BASE}/devices/me`, { headers: { ...I, 'user-agent': 'PatrolKit/202610021640 CFNetwork/1498.700.2.2.1 Darwin/23.6.0' } }).then(unwrap);
ok('the iPad’s /devices/me names its station’s bridge and the stock it holds',
  me.station?.printBridge?.deviceId === bridge.id && me.station.printBridge.printer?.paperSize === '25x67',
  JSON.stringify(me.station?.printBridge));

// ─── A pair, printed now ─────────────────────────────────────────────────────
await heartbeat();
const asked = await ask();
const askedBody = await unwrap(asked);
ok('an online bridge with an online 25 × 67 printer takes the pair', asked.status === 202 && askedBody.jobIds?.length === 2,
  `HTTP ${asked.status} ${JSON.stringify(askedBody).slice(0, 120)}`);

const got = await claim();
ok('one claim hands the bridge both stickers, in order', got.jobs?.map((j) => j.kind).join(',') === 'drawn_helper_labels,drawn_helper_labels',
  got.jobs?.map((j) => j.kind).join(','));
ok('...each the full head wide and the stock long', got.jobs?.every((j) => j.widthBytes === 72 && j.rasterBytes === 72 * (67 * 8 - 16)),
  got.jobs?.map((j) => `${j.widthBytes}×${j.rasterBytes}`).join(' '));
for (const j of got.jobs ?? []) await fetch(`${BASE}/devices/me/print-jobs/${j.id}/ack`, { method: 'POST', headers: B });

// ─── Refused at once, with a reason ──────────────────────────────────────────
await prisma.device.update({ where: { id: bridge.id }, data: { lastSeenAt: new Date(Date.now() - 30_000) } });
const offline = await ask();
const offlineBody = await offline.json();
ok('a bridge unseen for 30 seconds is refused as offline', offline.status === 409 && offlineBody.code === 'BRIDGE_OFFLINE',
  `HTTP ${offline.status} ${offlineBody.code}: ${offlineBody.error}`);

await heartbeat();
// A receipt, not a tag: this swap is on legacy tickets, so a tag would be refused
// as TAGS_OFF before the stock was ever asked about.
const receipt = await ask({ kind: 'receipt' });
const receiptBody = await receipt.json();
ok('a receipt is refused: this stock prints helper labels only', receipt.status === 409 && receiptBody.code === 'PRINTER_STOCK',
  `HTTP ${receipt.status} ${receiptBody.code}: ${receiptBody.error}`);

await prisma.swapPrinter.update({ where: { id: printer.id }, data: { paperSize: '62x100' } });
const stock = await ask();
const stockBody = await stock.json();
ok('a printer holding other stock is refused', stock.status === 409 && stockBody.code === 'PRINTER_STOCK',
  `HTTP ${stock.status} ${stockBody.code}`);
await prisma.swapPrinter.update({ where: { id: printer.id }, data: { paperSize: '25x67' } });

await fetch(`${BASE}/devices/me/print-jobs/claim?limit=0`, { method: 'POST', headers: B, body: JSON.stringify({ printerLink: 'down' }) });
const down = await ask();
ok('a printer the bridge reports down is refused', down.status === 409 && (await down.json()).code === 'PRINTER_OFFLINE', `HTTP ${down.status}`);

// ─── Not printed late ────────────────────────────────────────────────────────
await heartbeat();
const late = await unwrap(await ask());
await prisma.printJob.updateMany({ where: { id: { in: late.jobIds } }, data: { notAfter: new Date(Date.now() - 1_000) } });
const afterExpiry = await claim();
const dropped = await prisma.printJob.findMany({ where: { id: { in: late.jobIds } } });
ok('a pair its bridge did not take within its minute is dropped, not printed',
  afterExpiry.jobs?.length === 0 && dropped.every((j) => j.status === 'abandoned' && /within a minute/.test(j.lastError ?? '')),
  `${afterExpiry.jobs?.length} claimed; ${dropped.map((j) => `${j.status}: ${j.lastError}`).join('; ')}`);

// ─── Nothing else prints here ────────────────────────────────────────────────
const { user } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const S = { authorization: `Bearer ${await smokeSession(prisma, BASE, user, unwrap)}`, 'content-type': 'application/json' };
const queueNow = await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${station.id}/queue`, { headers: S }).then(unwrap);
ok('the station’s status shows the build its iPad reported', queueNow.attendantAppBuild === '202610021640' && queueNow.attendantAppVersion === null,
  `${queueNow.attendantAppVersion} / ${queueNow.attendantAppBuild}`);
await fetch(`${BASE}/devices/me`, { headers: { ...I, 'x-app-version': '1.4.0', 'x-app-build': '202610031200' } });
const queueLater = await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${station.id}/queue`, { headers: S }).then(unwrap);
ok('...and its version once the iPad sends the headers', queueLater.attendantAppVersion === '1.4.0' && queueLater.attendantAppBuild === '202610031200',
  `${queueLater.attendantAppVersion} / ${queueLater.attendantAppBuild}`);
ok('the station’s status says why the pair gave up', /within a minute/.test(queueNow.lastAbandonedReason ?? ''), queueNow.lastAbandonedReason);
const listed = await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations`, { headers: S }).then(unwrap);
const row = (Array.isArray(listed) ? listed : listed.stations ?? []).find((s) => s.id === station.id);
ok('the station row says its bridge prints helper labels only', row?.helperLabelsOnly === true, JSON.stringify(row?.helperLabelsOnly));

await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${station.id}/test`, { method: 'POST', headers: S });
const test = await claim();
ok('the station’s Test prints a sample pair of stickers, not a calibration label',
  test.jobs?.map((j) => j.kind).join(',') === 'helper_item,helper_office', test.jobs?.map((j) => j.kind).join(','));
for (const j of test.jobs ?? []) await fetch(`${BASE}/devices/me/print-jobs/${j.id}/ack`, { method: 'POST', headers: B });

const saved = await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`, {
  method: 'POST', headers: S, body: JSON.stringify({ priceCents: 1000, quantity: 1, stationId: station.id }),
});
const savedItem = await unwrap(saved);
const tagJobs = await prisma.printJob.count({ where: { itemId: savedItem.id } });
ok('an item saved at the station saves, and queues no tag', saved.status === 201 && tagJobs === 0 && savedItem.hasPrintedTag === false,
  `HTTP ${saved.status}, ${tagJobs} tag jobs`);

const retired = await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${station.id}/helper-labels`, { method: 'POST', headers: I, body: '{}' });
ok('the retired helper-labels endpoint is gone', retired.status === 404, `HTTP ${retired.status}`);

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.printJob.deleteMany({ where: { stationId: station.id } });
await prisma.checkinStation.delete({ where: { id: station.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.swapPrinter.delete({ where: { id: printer.id } });
await prisma.device.deleteMany({ where: { clientId: { startsWith: SEED } } });
await prisma.$disconnect();

console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
