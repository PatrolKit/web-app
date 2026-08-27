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

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const org = await smokeOrg(prisma);
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
    role: 'ski_swap.print_bridge',
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

const { user: staffEarly } = await smokeStaff(prisma, org, ['ski_swap:report', 'ski_swap:manage']);
const staffTokenEarly = await smokeSession(prisma, BASE, staffEarly, unwrap);

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
ok('payload decodes to a whole number of rows', (() => {
  const bytes = Buffer.from(job.payload, 'base64');
  return bytes.length % 50 === 0 && bytes.length > 0;
})(), `${Buffer.from(job.payload, 'base64').length} bytes`);

if (job) {
  const bytes = Buffer.from(job.payload, 'base64');
  // The bridge builds its own ESC/POS and adds its own feed rows, so a finished
  // job here would be double-wrapped and print garbage rather than failing.
  // This is the exact preamble its payload_is_escpos() looks for.
  const looksLikeEscPos =
    bytes.length >= 14 &&
    bytes[0] === 0x1b && bytes[1] === 0x40 &&
    bytes[2] === 0x1f && bytes[10] === 0x1d && bytes[11] === 0x76;
  ok('payload is a bare raster, not a finished job', !looksLikeEscPos,
     bytes.subarray(0, 8).toString('hex'));
  ok('payload is one 50x30 label at 400 dots wide', bytes.length === 224 * 50,
     `${bytes.length} bytes, expected ${224 * 50}`);
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
          secretHash: await argon2.hash(secret), role: 'ski_swap.print_bridge' },
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

// ─── Self-reporting ──────────────────────────────────────────────────────────
// A bridge whose printer is down stops taking work, so without a heartbeat it
// would be indistinguishable from a bridge that lost power — and those need
// different people to fix them.

const beat = await fetch(`${BASE}/devices/me/print-jobs/claim?limit=0`, {
  method: 'POST', headers: H, body: JSON.stringify({ printerLink: 'down' }),
}).then(unwrap);
ok('a heartbeat claims nothing', beat.jobs.length === 0, JSON.stringify(beat));

let health = await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${station.id}/queue`, {
  headers: { authorization: `Bearer ${staffTokenEarly}` },
}).then(unwrap);
ok('a downed printer is reported to staff', health.printerLink === 'down', JSON.stringify(health.printerLink));
ok('and is timestamped, so a stale answer can be discounted', !!health.printerLinkAt, String(health.printerLinkAt));

await fetch(`${BASE}/devices/me/print-jobs/claim?limit=0`, {
  method: 'POST', headers: H, body: JSON.stringify({ printerLink: 'ready' }),
}).then(unwrap);
health = await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${station.id}/queue`, {
  headers: { authorization: `Bearer ${staffTokenEarly}` },
}).then(unwrap);
ok('a recovered printer is reported too', health.printerLink === 'ready', String(health.printerLink));

// Saying nothing leaves the last answer standing rather than blanking it.
await fetch(`${BASE}/devices/me/print-jobs/claim?limit=0`, { method: 'POST', headers: H }).then(unwrap);
health = await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${station.id}/queue`, {
  headers: { authorization: `Bearer ${staffTokenEarly}` },
}).then(unwrap);
ok('silence does not erase the last report', health.printerLink === 'ready', String(health.printerLink));

// ─── The reaper ──────────────────────────────────────────────────────────────
// A bridge that dies mid-print never acks and never nacks. The claim has to
// both recover those jobs and, eventually, stop trying — otherwise one job that
// hangs a printer blocks its station for the rest of the swap.

await prisma.printJob.deleteMany({ where: { stationId: station.id } });
const stuck = await prisma.printJob.create({
  data: { orgId: org.id, stationId: station.id, kind: 'calibration' },
});

// Expire the claim by hand rather than waiting 90 seconds for it.
const expire = (attempts) =>
  prisma.printJob.update({
    where: { id: stuck.id },
    data: { status: 'claimed', claimToken: 'stale', claimUntil: new Date(Date.now() - 1000), attempts },
  });

await expire(1);
const recovered = await fetch(`${BASE}/devices/me/print-jobs/claim`, { method: 'POST', headers: H }).then(unwrap);
ok('an expired claim returns to the queue', recovered.jobs.length === 1, `${recovered.jobs.length} jobs`);

await expire(5); // MAX_ATTEMPTS
const afterCap = await fetch(`${BASE}/devices/me/print-jobs/claim`, { method: 'POST', headers: H }).then(unwrap);
ok('a job past its attempts is not re-claimed', afterCap.jobs.length === 0, `${afterCap.jobs.length} jobs`);
ok('and is abandoned rather than left claimed',
   (await prisma.printJob.findUnique({ where: { id: stuck.id } })).status === 'abandoned',
   (await prisma.printJob.findUnique({ where: { id: stuck.id } })).status);

// Staff can see it, which is the whole point of abandoning rather than looping
// forever. This needs a *person's* session — H above is the bridge's.
const depth = await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${station.id}/queue`, {
  headers: { authorization: `Bearer ${staffTokenEarly}` },
}).then(unwrap);
ok('the station reports it as abandoned, not queued',
   depth.abandoned === 1 && depth.queued === 0, JSON.stringify(depth));

await prisma.printJob.deleteMany({ where: { stationId: station.id } });

// A device of the wrong role is refused outright
const checkin = await prisma.device.create({
  data: { orgId: org.id, name: 'Smoke iPad', clientId: 'smoke-bridge-3',
          secretHash: await argon2.hash(secret), role: 'ski_swap.staff_check_in' },
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
