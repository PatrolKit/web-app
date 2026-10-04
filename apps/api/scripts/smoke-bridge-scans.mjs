// The firmware contract: assignments carried on the claim, the scanner report
// travelling with it, and a scan accepting an item.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-bridge-scans.mjs
//
// Drives the device endpoints with a real device token, the way a bridge does.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import argon2 from 'argon2';

import { smokeOrg } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const org = await smokeOrg(prisma);

// ─── Fixtures ────────────────────────────────────────────────────────────────
await prisma.printJob.deleteMany({ where: { orgId: org.id } });
await prisma.swapItem.deleteMany({ where: { orgId: org.id, swap: { title: { startsWith: 'Scan smoke' } } } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'Scan smoke station' } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: { startsWith: 'Scan smoke' } } });
await prisma.swapScanner.deleteMany({ where: { orgId: org.id } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Scan smoke' } } });
await prisma.device.deleteMany({ where: { orgId: org.id, name: 'Scan smoke bridge' } });

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, slug: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title: 'Scan smoke swap', squareCategoryId: 'scan-smoke',
    skuPrefix: 'SCN', active: true, activeSkuPrefix: 'SCN',
  },
});

// A bridge with real credentials, so the device token exchange is exercised.
const clientId = createId();
const clientSecret = createId();
const bridge = await prisma.device.create({
  data: {
    id: createId(), orgId: org.id, name: 'Scan smoke bridge',
    role: 'ski_swap.print_bridge', clientId,
    // argon2id, the way `DevicesService` provisions one — the token exchange
    // verifies against this, so a stand-in hash gets a 401 that looks like a
    // broken endpoint rather than a broken fixture.
    secretHash: await argon2.hash(clientSecret, { type: argon2.argon2id }),
  },
});
const station = await prisma.checkinStation.create({
  data: {
    id: createId(), orgId: org.id, name: 'Scan smoke station', code: 'S',
    bridgeDeviceId: bridge.id, updatedAt: new Date(),
  },
});
const printer = await prisma.swapPrinter.create({
  data: {
    id: createId(), orgId: org.id, name: 'Scan smoke printer',
    bluetoothName: 'Q192E28B1060137', paperSize: '50x30',
    bridgeDeviceId: bridge.id, updatedAt: new Date(),
  },
});

const tokenRes = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId, clientSecret }),
}).then(unwrap);
const H = { authorization: `Bearer ${tokenRes.accessToken}`, 'content-type': 'application/json' };

const claim = (body = {}) =>
  fetch(`${BASE}/devices/me/print-jobs/claim?limit=0&wait=0`, {
    method: 'POST', headers: H, body: JSON.stringify(body),
  }).then(unwrap);

// ─── §1 Assignments ride the claim ───────────────────────────────────────────

const first = await claim();
ok('a claim names the printer this bridge should hold',
   first.printer?.bluetoothName === 'Q192E28B1060137', JSON.stringify(first.printer));
ok('and says null for a scanner it has none of', first.scanner === null,
   JSON.stringify(first.scanner));

const scanner = await prisma.swapScanner.create({
  data: {
    id: createId(), orgId: org.id, name: 'Scan smoke scanner',
    bluetoothName: 'BCST-23-Z9Y8', bridgeDeviceId: bridge.id, updatedAt: new Date(),
  },
});
const withScanner = await claim();
ok('assigning a scanner shows up on the next claim, with nobody touching the board',
   withScanner.scanner?.bluetoothName === 'BCST-23-Z9Y8', JSON.stringify(withScanner.scanner));

// Reassignment is the whole point of §1: no BLE re-provisioning.
await prisma.swapPrinter.update({
  where: { id: printer.id }, data: { bluetoothName: 'Q000NEWPRINTER0' },
});
const moved = await claim();
ok('changing the printer is picked up within one claim',
   moved.printer?.bluetoothName === 'Q000NEWPRINTER0', JSON.stringify(moved.printer));

await prisma.swapPrinter.update({ where: { id: printer.id }, data: { bridgeDeviceId: null } });
const released = await claim();
ok('releasing it sends null, which means drop what you are holding',
   released.printer === null, JSON.stringify(released.printer));

// ─── §2 The scanner report ───────────────────────────────────────────────────

await claim({ printerLink: 'ready', scannerLink: 'down', scannerBattery: 84, scanQueueDepth: 3 });
let d = await prisma.device.findUnique({ where: { id: bridge.id } });
ok('a scanner report is recorded', d.scannerLink === 'down', String(d.scannerLink));
ok('with a timestamp, because a stale answer means nothing', d.scannerLinkAt !== null,
   String(d.scannerLinkAt));
ok('and the battery it last saw', d.scannerBattery === 84, String(d.scannerBattery));
ok('and how many scans are stuck', d.scanQueueDepth === 3, String(d.scanQueueDepth));
ok('while the printer link is untouched by it', d.printerLink === 'ready', String(d.printerLink));

// Omitting a field leaves the last report standing rather than clearing it.
await claim({ printerLink: 'ready' });
d = await prisma.device.findUnique({ where: { id: bridge.id } });
ok('saying nothing about the scanner is not saying it is down',
   d.scannerLink === 'down' && d.scannerBattery === 84,
   `${d.scannerLink} / ${d.scannerBattery}`);

await claim({ scannerLink: 'ready', scanQueueDepth: 0 });
d = await prisma.device.findUnique({ where: { id: bridge.id } });
ok('a recovered scanner is recorded', d.scannerLink === 'ready' && d.scanQueueDepth === 0,
   `${d.scannerLink} / ${d.scanQueueDepth}`);

// ─── §3 A scan accepts the item ──────────────────────────────────────────────

const scanUrl = `${BASE}/devices/me/scans`;
const post = (sku) => fetch(scanUrl, { method: 'POST', headers: H, body: JSON.stringify({ sku }) });

/** An item waiting to be accepted, the way a self check-in leaves one. */
async function waitingItem(sku) {
  return prisma.swapItem.create({
    data: {
      id: createId(), orgId: org.id, swapId: swap.id, name: `Item ${sku}`,
      priceCents: 5000, sku, originalQuantity: 1, consignedAt: null,
    },
  });
}

const waiting = await waitingItem('SCN-S-0001');
const accepted = await post('SCN-S-0001');
const acceptedBody = await accepted.json();
ok('a scan is accepted', accepted.status === 200, String(accepted.status));

const afterScan = await prisma.swapItem.findUnique({ where: { id: waiting.id } });
ok('AND IT CONSIGNS THE ITEM', afterScan.consignedAt !== null, String(afterScan.consignedAt));
ok('recording the bridge as who accepted it', afterScan.consignedBy === bridge.id,
   String(afterScan.consignedBy));
ok('and says so in the body, for whoever reads a log',
   acceptedBody.data?.sku === 'SCN-S-0001', JSON.stringify(acceptedBody.data ?? acceptedBody));

// The firmware retries on a lost response, so a repeat must not be an error.
const repeat = await post('SCN-S-0001');
ok('scanning the same tag again is accepted, not an error', repeat.status === 200,
   String(repeat.status));
const unchanged = await prisma.swapItem.findUnique({ where: { id: waiting.id } });
ok('and does not move when it was accepted',
   unchanged.consignedAt.getTime() === afterScan.consignedAt.getTime(),
   `${unchanged.consignedAt.toISOString()} vs ${afterScan.consignedAt.toISOString()}`);

// An org not using acceptance has everything consigned already, so a scan is a
// no-op — which is what "only consigns when the setting is on" comes to.
const already = await prisma.swapItem.create({
  data: {
    id: createId(), orgId: org.id, swapId: swap.id, name: 'Already on the floor',
    priceCents: 1000, sku: 'SCN-S-0002', originalQuantity: 1, consignedAt: new Date('2026-01-01T00:00:00Z'),
  },
});
const noop = await post('SCN-S-0002');
ok('scanning an item that never had to wait is accepted', noop.status === 200, String(noop.status));
const stillOriginal = await prisma.swapItem.findUnique({ where: { id: already.id } });
ok('and changes nothing about it',
   stillOriginal.consignedAt.toISOString() === '2026-01-01T00:00:00.000Z',
   stillOriginal.consignedAt.toISOString());

const unknown = await post('NOSUCHTAG');
ok('an unknown tag is a 4xx, so the firmware drops it rather than retrying',
   unknown.status === 404, String(unknown.status));

const legacy = await waitingItem('67169');
await post('67169');
const legacyAfter = await prisma.swapItem.findUnique({ where: { id: legacy.id } });
ok('a bare legacy ticket number scans the same as one of ours',
   legacyAfter.consignedAt !== null, String(legacyAfter.consignedAt));

// An item in a closed swap is not scannable: the tag in somebody's hand belongs
// to whatever is running now.
const oldSwap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, slug: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title: 'Scan smoke last year', squareCategoryId: 'scan-old',
    skuPrefix: 'OLD', active: false,
  },
});
await prisma.swapItem.create({
  data: {
    id: createId(), orgId: org.id, swapId: oldSwap.id, name: 'Last year',
    priceCents: 1000, sku: 'OLD-S-0001', originalQuantity: 1, consignedAt: null,
  },
});
const closed = await post('OLD-S-0001');
ok('a tag from a swap that is not running is refused', closed.status === 404, String(closed.status));

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.swapItem.deleteMany({ where: { swapId: { in: [swap.id, oldSwap.id] } } });
await prisma.swapSkuCounter.deleteMany({ where: { swapId: { in: [swap.id, oldSwap.id] } } });
await prisma.printJob.deleteMany({ where: { stationId: station.id } });
await prisma.checkinStation.delete({ where: { id: station.id } });
await prisma.swapScanner.delete({ where: { id: scanner.id } });
await prisma.swapPrinter.delete({ where: { id: printer.id } });
await prisma.skiSwap.deleteMany({ where: { id: { in: [swap.id, oldSwap.id] } } });
await prisma.device.delete({ where: { id: bridge.id } });
await prisma.$disconnect();
