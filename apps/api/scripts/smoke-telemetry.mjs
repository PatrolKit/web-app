// Bridge telemetry (webprinter_esp32 Plan 4), and outages measured from
// check-ins, against a running API and a real database.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-telemetry.mjs
//
// The rule the firmware cared about most: a report is never refused over its
// contents. Fields the server has not heard of are kept, a wrongly typed one is
// noted rather than rejected, and only a body that is not an object, or is too
// big, is refused. A claim schema that refused an unknown field once took a
// bridge offline.

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { smokeOrg, smokeSession, smokeSuperAdmin, dropSmokeAdmin, smokeStaff } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

// ─── Fixtures ────────────────────────────────────────────────────────────────
const org = await smokeOrg(prisma);
const SEED = 'telemetry-smoke';
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'Telemetry smoke station' } });
await prisma.device.deleteMany({ where: { clientId: { startsWith: SEED } } });
const secret = 'telemetry-smoke-secret';
const bridge = await prisma.device.create({
  data: { orgId: org.id, name: 'Telemetry bridge', clientId: `${SEED}-bridge`, secretHash: await argon2.hash(secret), role: 'ski_swap.print_bridge' },
});
// Whichever code is free: codes are unique within an org, deleted stations
// included, and the other smoke scripts each hold one.
const taken = new Set((await prisma.checkinStation.findMany({ where: { orgId: org.id }, select: { code: true } })).map((s) => s.code));
const code = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find((c) => !taken.has(c));
const station = await prisma.checkinStation.create({
  data: { orgId: org.id, name: 'Telemetry smoke station', code, bridgeDeviceId: bridge.id },
});
const token = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: `${SEED}-bridge`, clientSecret: secret }),
}).then(unwrap);
const H = { authorization: `Bearer ${token.accessToken}`, 'content-type': 'application/json' };

const report = (body) => fetch(`${BASE}/devices/me/telemetry`, {
  method: 'POST', headers: H, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const REPORT = {
  v: 1,
  firmware: { version: '797451c', board: 'sparkle_motion_mini', idf: 'v6.0' },
  boot: { count: 42, resetReason: 'poweron', uptimeMs: 60_000 },
  memory: { free: 25636, largestBlock: 16384, minFreeEver: 12000, psram: false },
  wifi: { rssi: -61, reconnects: 0 },
  printer: { link: 'ready', reconnects: 3, jobsPrinted: 1, rasterReRenders: 0 },
  scanner: null,
};

// ─── Taking reports ──────────────────────────────────────────────────────────
const first = await report({ ...REPORT, radio: { channel: 6 } });
const firstBody = await first.json();
ok('a report is taken, and the bridge is told how often to send the next',
  first.status === 200 && firstBody.data?.intervalS === 300, `${first.status} ${JSON.stringify(firstBody)}`);
const stored = await prisma.deviceTelemetry.findFirst({ where: { deviceId: bridge.id }, orderBy: { receivedAt: 'desc' } });
ok('...kept as sent, a field the server has never heard of included', stored?.body?.radio?.channel === 6,
  JSON.stringify(stored?.body));
ok('...with the fields worth querying copied out', stored?.memMinFreeEver === 12000 && stored?.firmwareVersion === '797451c' &&
  stored?.bootCount === 42 && stored?.bootAt instanceof Date);

const typo = await report({ ...REPORT, memory: { ...REPORT.memory, free: 'lots' } });
const typoRow = await prisma.deviceTelemetry.findFirst({ where: { deviceId: bridge.id }, orderBy: { receivedAt: 'desc' } });
ok('a wrongly typed field does not lose the report', typo.status === 200 && typoRow.memFree === null &&
  JSON.stringify(typoRow.malformedFields) === '["memory.free"]', `${typo.status} ${JSON.stringify(typoRow?.malformedFields)}`);

const crash = await report({ ...REPORT, boot: { count: 43, resetReason: 'task_wdt', uptimeMs: 4_000 } });
const crashRow = await prisma.deviceTelemetry.findFirst({ where: { deviceId: bridge.id }, orderBy: { receivedAt: 'desc' } });
ok('a new boot after a watchdog is an unplanned reboot', crash.status === 200 && crashRow.bootsSincePrevious === 1 &&
  crashRow.unplannedReboot === true);

const array = await report([1, 2, 3]);
ok('a body that is not an object is refused', array.status === 400, `HTTP ${array.status}`);
const big = await report({ ...REPORT, pad: 'x'.repeat(5000) });
ok('a body over 4 KB is refused with 413', big.status === 413, `HTTP ${big.status}`);
const bad = await report('{not json');
ok('a body that is not JSON is refused', bad.status === 400, `HTTP ${bad.status}`);

// ─── Outages from check-ins ──────────────────────────────────────────────────
const claim = () => fetch(`${BASE}/devices/me/print-jobs/claim?limit=0`, { method: 'POST', headers: H, body: '{}' });
await claim();
await prisma.device.update({ where: { id: bridge.id }, data: { lastSeenAt: new Date(Date.now() - 45_000) } });
await claim();
const outage = await prisma.deviceOutage.findFirst({ where: { deviceId: bridge.id } });
ok('a check-in after 45 silent seconds records an outage', !!outage &&
  outage.endedAt.getTime() - outage.startedAt.getTime() >= 44_000, JSON.stringify(outage));
await claim();
ok('...and a normal check-in records none', (await prisma.deviceOutage.count({ where: { deviceId: bridge.id } })) === 1);

// ─── What Platform Admin sees ────────────────────────────────────────────────
const admin = await smokeSuperAdmin(prisma);
const adminToken = await smokeSession(prisma, BASE, admin, unwrap);
const A = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };

const fleet = await fetch(`${BASE}/admin/telemetry/bridges/summary?range=24h`, { headers: A }).then(unwrap);
const row = fleet.bridges?.find((b) => b.id === bridge.id);
ok('the fleet view counts the crash and the outage', row?.unplannedReboots === 1 && row?.outages === 1 &&
  row?.disconnectedMs >= 44_000 && row?.lowestMemory === 12000, JSON.stringify(row));

const set = await fetch(`${BASE}/admin/telemetry/bridges/${bridge.id}/interval`, {
  method: 'PATCH', headers: A, body: JSON.stringify({ intervalS: 60 }),
});
// The same boot as the crash report, a minute on.
const next = await report({ ...REPORT, boot: { count: 43, resetReason: 'task_wdt', uptimeMs: 64_000 } }).then((r) => r.json());
ok('turning reporting up tells the bridge at its next report', set.status === 200 && next.data?.intervalS === 60,
  JSON.stringify(next));
const tooFast = await fetch(`${BASE}/admin/telemetry/bridges/${bridge.id}/interval`, {
  method: 'PATCH', headers: A, body: JSON.stringify({ intervalS: 5 }),
});
ok('...but not below a minute', tooFast.status === 400, `HTTP ${tooFast.status}`);

const history = await fetch(`${BASE}/admin/telemetry/bridges/${bridge.id}?range=24h`, { headers: A }).then(unwrap);
ok('the bridge view has its reboots, outages and memory', history.reboots?.[0]?.reason === 'task_wdt' &&
  history.outages?.length === 1 && history.memory?.points?.some((p) => p.minFreeEver === 12000),
  JSON.stringify({ reboots: history.reboots, outages: history.outages }));

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:admin']);
const staffToken = await smokeSession(prisma, BASE, staff, unwrap);
const closed = await fetch(`${BASE}/admin/telemetry/bridges/summary`, { headers: { authorization: `Bearer ${staffToken}` } });
ok('...and none of it is open to anybody but a super admin', closed.status === 403, `HTTP ${closed.status}`);

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.checkinStation.delete({ where: { id: station.id } });
await prisma.device.deleteMany({ where: { clientId: { startsWith: SEED } } });
await dropSmokeAdmin(prisma);
await prisma.$disconnect();

console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
