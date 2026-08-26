// End-to-end check of the print queue against a running API and a real database.
//
// The claim is a hand-written UPDATE ... ORDER BY ... LIMIT — the one place in
// the queue where Prisma cannot express what we need, and so the one place a
// unit test cannot cover honestly. Run this after touching the queue, and after
// a deploy, before a venue depends on it.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-print-queue.mjs
//
// It creates its own org-scoped fixtures and deletes them on the way out.
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const org = await prisma.organization.findFirst();
console.log('org:', org.id, org.name);

// Clean any prior run
await prisma.printJob.deleteMany({ where: { orgId: org.id } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Smoke' } } });
await prisma.device.deleteMany({ where: { orgId: org.id, clientId: { startsWith: 'smoke-' } } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Smoke' } } });

const secret = 'smoke-secret-value';
const device = await prisma.device.create({
  data: {
    orgId: org.id,
    name: 'Smoke bridge',
    clientId: 'smoke-bridge-1',
    secretHash: await argon2.hash(secret),
    role: 'Ski Swap - Network Printer Adapter',
  },
});
const printer = await prisma.swapPrinter.create({
  data: { orgId: org.id, name: 'Smoke printer', bluetoothName: 'M110-SMOKE', bridgeDeviceId: device.id },
});

// Station code allocation goes through the real service path via HTTP later;
// here we place one directly so the queue has a target.
const station = await prisma.checkinStation.create({
  data: { orgId: org.id, name: 'Smoke station', code: 'S', deviceId: device.id, printerId: printer.id },
});

const tok = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: 'smoke-bridge-1', clientSecret: secret }),
}).then(unwrap);
ok('device token issued', !!tok.accessToken, tok.accessToken ? '' : JSON.stringify(tok));
const H = { authorization: `Bearer ${tok.accessToken}`, 'content-type': 'application/json' };

// Empty queue first
let claim = await fetch(`${BASE}/devices/me/print-jobs/claim`, { method: 'POST', headers: H }).then(unwrap);
ok('empty claim returns idle backoff', claim.jobs.length === 0 && claim.backoffMs === 5000, JSON.stringify(claim));

// Enqueue a calibration through the queue service's own table shape
await prisma.printJob.create({
  data: { orgId: org.id, stationId: station.id, printerId: printer.id, kind: 'calibration' },
});

claim = await fetch(`${BASE}/devices/me/print-jobs/claim`, { method: 'POST', headers: H }).then(unwrap);
ok('claims the queued job', claim.jobs.length === 1, JSON.stringify(claim).slice(0, 200));
const job = claim.jobs[0];
ok('payload is base64 ESC/POS', typeof job.payload === 'string' && job.payload.length > 100,
   `${job?.payload?.length ?? 0} chars`);
if (job) {
  const bytes = Buffer.from(job.payload, 'base64');
  ok('payload starts with ESC @', bytes[0] === 0x1b && bytes[1] === 0x40, bytes.subarray(0, 8).toString('hex'));
  ok('payload contains GS v 0 raster', bytes.includes(Buffer.from([0x1d, 0x76, 0x30])));
}

// A second claim must not re-issue the same job
const claim2 = await fetch(`${BASE}/devices/me/print-jobs/claim`, { method: 'POST', headers: H }).then(unwrap);
ok('claimed job is not re-issued', claim2.jobs.length === 0, JSON.stringify(claim2));

// Nack returns it to the queue
let res = await fetch(`${BASE}/devices/me/print-jobs/${job.id}/nack`, {
  method: 'POST', headers: H, body: JSON.stringify({ error: 'paper out' }),
});
ok('nack accepted', res.status === 204, String(res.status));
let row = await prisma.printJob.findUnique({ where: { id: job.id } });
ok('nack requeues', row.status === 'queued' && row.claimToken === null && row.lastError === 'paper out', row.status);

const claim3 = await fetch(`${BASE}/devices/me/print-jobs/claim`, { method: 'POST', headers: H }).then(unwrap);
ok('requeued job comes back', claim3.jobs.length === 1);
ok('attempts incremented', (await prisma.printJob.findUnique({ where: { id: job.id } })).attempts === 2);

res = await fetch(`${BASE}/devices/me/print-jobs/${job.id}/ack`, { method: 'POST', headers: H });
ok('ack accepted', res.status === 204, String(res.status));
row = await prisma.printJob.findUnique({ where: { id: job.id } });
ok('ack marks printed', row.status === 'printed' && row.printedAt !== null, row.status);

// Another device may not touch this station's jobs
const other = await prisma.device.create({
  data: { orgId: org.id, name: 'Smoke bridge 2', clientId: 'smoke-bridge-2',
          secretHash: await argon2.hash(secret), role: 'Ski Swap - Network Printer Adapter' },
});
const tok2 = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: 'smoke-bridge-2', clientSecret: secret }),
}).then(unwrap);
await prisma.printJob.create({ data: { orgId: org.id, stationId: station.id, kind: 'calibration' } });
const foreign = await fetch(`${BASE}/devices/me/print-jobs/claim`, {
  method: 'POST', headers: { authorization: `Bearer ${tok2.accessToken}` },
});
ok('unbound bridge is told so, not fed jobs', foreign.status === 404, String(foreign.status));

// A device of the wrong role is refused outright
const checkin = await prisma.device.create({
  data: { orgId: org.id, name: 'Smoke iPad', clientId: 'smoke-bridge-3',
          secretHash: await argon2.hash(secret), role: 'Ski Swap - Check-in Station' },
});
const tok3 = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: 'smoke-bridge-3', clientSecret: secret }),
}).then(unwrap);
res = await fetch(`${BASE}/devices/me/print-jobs/claim`, {
  method: 'POST', headers: { authorization: `Bearer ${tok3.accessToken}` },
});
ok('wrong device role is refused', res.status === 403, String(res.status));

await prisma.printJob.deleteMany({ where: { orgId: org.id } });
await prisma.checkinStation.deleteMany({ where: { id: station.id } });
await prisma.device.deleteMany({ where: { id: { in: [device.id, other.id, checkin.id] } } });
await prisma.swapPrinter.deleteMany({ where: { id: printer.id } });
await prisma.$disconnect();
