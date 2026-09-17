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
  // A station reaches its printer through its bridge, so the bridge is what
  // the printer is bound to.
  data: { orgId: org.id, name: 'Smoke printer', bluetoothName: 'M110-SMOKE', bridgeDeviceId: device.id },
});

// Station code allocation goes through the real service path via HTTP later;
// here we place one directly so the queue has a target.
const station = await prisma.checkinStation.create({
  data: { orgId: org.id, name: 'Smoke station', code: 'S', bridgeDeviceId: device.id },
});

const { user: staffEarly } = await smokeStaff(prisma, org, ['ski_swap:report', 'ski_swap:manage', 'ski_swap:admin']);
const staffTokenEarly = await smokeSession(prisma, BASE, staffEarly, unwrap);

const tok = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: 'smoke-bridge-1', clientSecret: secret }),
}).then(unwrap);
ok('device token issued', !!tok.accessToken, tok.accessToken ? '' : JSON.stringify(tok));
const H = { authorization: `Bearer ${tok.accessToken}`, 'content-type': 'application/json' };

// Empty queue first
let claim = await fetch(`${BASE}/devices/me/print-jobs/claim?wait=0`, { method: 'POST', headers: H }).then(unwrap);
ok('empty claim returns idle backoff', claim.jobs.length === 0 && claim.backoffMs === 1000, JSON.stringify(claim));

// ─── Holding an empty claim ─────────────────────────────────────────────────
// The gap between a seller pressing print and the printer moving used to be a
// whole polling interval, because an idle bridge was told "nothing" and sent
// away. It now waits at the server and is woken by the enqueue.

let t0 = Date.now();
await fetch(`${BASE}/devices/me/print-jobs/claim?wait=1500`, { method: 'POST', headers: H }).then(unwrap);
const heldFor = Date.now() - t0;
ok('an empty claim is held rather than answered', heldFor >= 1400, `${heldFor} ms`);

// A bridge mid-print is never held.
//
// The firmware flushes acks at the top of its loop, right before it claims, so
// an ack can only leave between requests. Holding a bridge that still owes one
// sits on the message saying the paper came out, and the seller watches a
// spinner for a print that finished — measured at nine seconds before this.
await prisma.printJob.create({ data: { orgId: org.id, stationId: station.id, kind: 'calibration' } });
const held = await fetch(`${BASE}/devices/me/print-jobs/claim`, { method: 'POST', headers: H }).then(unwrap);
ok('claims the job it will print', held.jobs.length === 1, String(held.jobs.length));

t0 = Date.now();
const midPrint = await fetch(`${BASE}/devices/me/print-jobs/claim`, { method: 'POST', headers: H }).then(unwrap);
const waitedMidPrint = Date.now() - t0;
ok('a bridge that still owes an ack is answered at once', waitedMidPrint < 1000,
   `${waitedMidPrint} ms, ${midPrint.jobs.length} job(s)`);
for (const j of held.jobs) {
  await fetch(`${BASE}/devices/me/print-jobs/${j.id}/ack`, { method: 'POST', headers: H });
}

// Woken by the enqueue, not by a re-check: well under the 2s backstop.
t0 = Date.now();
const waiting = fetch(`${BASE}/devices/me/print-jobs/claim`, { method: 'POST', headers: H }).then(unwrap);
await new Promise((r) => setTimeout(r, 300));
await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${station.id}/test`, {
  method: 'POST', headers: { authorization: `Bearer ${staffTokenEarly}` },
});
const woken = await waiting;
const wokeAfter = Date.now() - t0;
ok('a held claim wakes when work is queued', woken.jobs.length === 1 && wokeAfter < 1500,
   `${wokeAfter} ms, ${woken.jobs.length} job(s)`);
for (const j of woken.jobs) {
  await fetch(`${BASE}/devices/me/print-jobs/${j.id}/ack`, { method: 'POST', headers: H });
}

// Enqueue a calibration through the queue service's own table shape
await prisma.printJob.create({
  data: { orgId: org.id, stationId: station.id, printerId: printer.id, kind: 'calibration' },
});

claim = await fetch(`${BASE}/devices/me/print-jobs/claim`, { method: 'POST', headers: H }).then(unwrap);
ok('claims the queued job', claim.jobs.length === 1, JSON.stringify(claim).slice(0, 200));
const job = claim.jobs[0];
// The bridge divides the payload by widthBytes to find the height and refuses a
// remainder, so these two have to agree or the job is dropped before it reaches
// the printer. That is how a 62 x 100 raster failed against a hard-coded 50.
ok('the job says how wide its rows are', job.widthBytes === 50, String(job.widthBytes));
ok('payload decodes to a whole number of those rows', (() => {
  const bytes = Buffer.from(job.payload, 'base64');
  return bytes.length % job.widthBytes === 0 && bytes.length > 0;
})(), `${Buffer.from(job.payload, 'base64').length} bytes / ${job.widthBytes}`);

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
  // The firmware's host suite pins this exact figure for the M110, so a change
  // here is a change to a number two repositories agree on.
  ok('and the M110 job is the 11,200 bytes the firmware tests against',
     bytes.length === 11200, String(bytes.length));
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

// ...but it is still heard. A bridge with no station is a bridge someone is
// mid-way through setting up, and it is the one that most needs to say whether
// it found its printer. Recording that after the 404 meant it never could, and
// a bridge sitting there connected read "printer unconfirmed" indefinitely.
await prisma.device.update({ where: { id: other.id }, data: { lastSeenAt: null } });
await fetch(`${BASE}/devices/me/print-jobs/claim?limit=0`, {
  method: 'POST',
  headers: { authorization: `Bearer ${tok2.accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ printerLink: 'ready' }),
});
const unbound = await prisma.device.findUnique({ where: { id: other.id } });
ok('an unbound bridge still reports its printer link', unbound.printerLink === 'ready',
   JSON.stringify({ printerLink: unbound.printerLink }));
// Cleared just above, so only the heartbeat can have set this — otherwise the
// token exchange would carry the assertion and it would prove nothing.
ok('and still counts as seen', unbound.lastSeenAt !== null,
   String(unbound.lastSeenAt));

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
const afterCap = await fetch(`${BASE}/devices/me/print-jobs/claim?wait=0`, { method: 'POST', headers: H }).then(unwrap);
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

// ─── Hardware follows the module ────────────────────────────────────────────
// The nav hides ski-swap devices when the module is off; the API has to refuse
// them too, or an org that switched ski swap off could still be handed bridges
// through hardware whose every other endpoint rejects the call.

await prisma.orgModule.updateMany({
  where: { orgId: org.id, moduleKey: 'ski_swap' },
  data: { enabled: false },
});

let gated = await fetch(`${BASE}/orgs/${org.id}/devices`, {
  method: 'POST',
  headers: { authorization: `Bearer ${staffTokenEarly}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Should not exist', role: 'ski_swap.print_bridge' }),
});
ok('a disabled module cannot be handed hardware', gated.status === 403, String(gated.status));

const listed = await fetch(`${BASE}/orgs/${org.id}/devices`, {
  headers: { authorization: `Bearer ${staffTokenEarly}` },
}).then(unwrap);
ok('and its existing hardware is not listed', Array.isArray(listed) && listed.length === 0,
   `${Array.isArray(listed) ? listed.length : '?'} devices`);

await prisma.orgModule.updateMany({
  where: { orgId: org.id, moduleKey: 'ski_swap' },
  data: { enabled: true },
});

gated = await fetch(`${BASE}/orgs/${org.id}/devices`, {
  headers: { authorization: `Bearer ${staffTokenEarly}` },
}).then(unwrap);
ok('turning it back on restores the hardware', Array.isArray(gated) && gated.length > 0,
   `${Array.isArray(gated) ? gated.length : '?'} devices`);

// ─── A printer serves exactly one thing ─────────────────────────────────────
// A printer is one BLE peripheral and whoever holds the link owns it. Two
// bridges on one printer means two masters fighting over it, and a bridged
// printer handed to a business seller means the bridge wins silently.

const H2 = { authorization: `Bearer ${staffTokenEarly}`, 'content-type': 'application/json' };

const second = await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations`, {
  method: 'POST', headers: H2, body: JSON.stringify({ name: 'Smoke station 2' }),
}).then(unwrap);
ok('a second station is created', !!second.id, JSON.stringify(second).slice(0, 80));

let res2 = await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${second.id}`, {
  method: 'PATCH', headers: H2, body: JSON.stringify({ bridgeDeviceId: device.id }),
});
ok('a bridge cannot serve two stations', res2.status === 409, String(res2.status));

const spare = await prisma.swapPrinter.create({
  data: { orgId: org.id, name: 'Smoke spare printer', bluetoothName: 'M110-SPARE' },
});
res2 = await fetch(`${BASE}/orgs/${org.id}/ski-swap/printers/${spare.id}`, {
  method: 'PATCH', headers: H2, body: JSON.stringify({ bridgeDeviceId: device.id }),
});
ok('a bridge cannot drive two printers', res2.status === 409, String(res2.status));

// A retired station has to let go, or its bridge is out of circulation for good.
await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${station.id}`, { method: 'DELETE', headers: H2 });
const freed = await prisma.checkinStation.findUnique({ where: { id: station.id } });
ok('retiring a station releases its bridge',
   freed.bridgeDeviceId === null && freed.deletedAt !== null,
   JSON.stringify({ bridgeDeviceId: freed.bridgeDeviceId, deletedAt: freed.deletedAt }));

res2 = await fetch(`${BASE}/orgs/${org.id}/ski-swap/stations/${second.id}`, {
  method: 'PATCH', headers: H2, body: JSON.stringify({ bridgeDeviceId: device.id }),
});
ok('and the bridge can then be bound elsewhere', res2.status === 200, String(res2.status));

// Releasing a bridge from its printer is what frees the printer for anything
// else — including a Bluetooth override from a tablet.
res2 = await fetch(`${BASE}/orgs/${org.id}/ski-swap/printers/${printer.id}`, {
  method: 'PATCH', headers: H2, body: JSON.stringify({ bridgeDeviceId: null }),
});
ok('a printer can be released from its bridge', res2.status === 200, String(res2.status));
res2 = await fetch(`${BASE}/orgs/${org.id}/ski-swap/printers/${spare.id}`, {
  method: 'PATCH', headers: H2, body: JSON.stringify({ bridgeDeviceId: device.id }),
});
ok('and the bridge can then take another printer', res2.status === 200, String(res2.status));

// The other direction: a printer a bridge drives cannot be handed to a seller.
const anySeller = await prisma.sellerProfile.findFirst({ where: { membership: { orgId: org.id } } });
if (anySeller) {
  res2 = await fetch(`${BASE}/orgs/${org.id}/ski-swap/printers/${spare.id}`, {
    method: 'PATCH', headers: H2, body: JSON.stringify({ assignedSellerId: anySeller.id }),
  });
  ok('a bridged printer cannot be assigned to a seller', res2.status === 409, String(res2.status));
} else {
  console.log('SKIP  bridged printer vs seller — no seller profile on this database');
}

await prisma.checkinStation.deleteMany({ where: { id: second.id } });

await prisma.printJob.deleteMany({ where: { orgId: org.id } });
await prisma.checkinStation.deleteMany({ where: { id: station.id } });
await prisma.device.deleteMany({ where: { id: { in: [device.id, other.id, checkin.id] } } });
await prisma.swapPrinter.deleteMany({ where: { id: { in: [printer.id, spare.id] } } });
await prisma.$disconnect();
