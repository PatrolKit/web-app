// A claimed job's raster as raw bytes, for a bridge with no PSRAM.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-raster-download.mjs
//
// The Sparkle Motion Mini's largest free block is 72 KB. A 62 × 100 raster is
// 56,448 bytes, which fits; the same raster as base64 inside a claim is ~75 KB,
// which does not. So the bridge claims with `payload=omit`, reads the size, and
// streams the bytes from `GET …/raster` straight into one buffer.
//
// What it depends on is all on the wire — an exact Content-Length, no chunking,
// no compression, identical bytes on a second fetch — so this checks the real
// response rather than the service. Run it against production after a deploy
// too: Caddy is part of the path it is checking.

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

// ─── Fixtures: an M221 on 62 × 100, the label the Sparkle could not take ─────
const org = await smokeOrg(prisma);
const SEED = 'raster-smoke';
await prisma.printJob.deleteMany({ where: { orgId: org.id, station: { name: 'Raster smoke station' } } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'Raster smoke station' } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: 'Raster smoke printer' } });
await prisma.device.deleteMany({ where: { clientId: { startsWith: SEED } } });

const secret = 'raster-smoke-secret';
const bridge = await prisma.device.create({
  data: { orgId: org.id, name: 'Raster bridge', clientId: `${SEED}-bridge`, secretHash: await argon2.hash(secret), role: 'ski_swap.print_bridge' },
});
const stranger = await prisma.device.create({
  data: { orgId: org.id, name: 'Raster stranger', clientId: `${SEED}-stranger`, secretHash: await argon2.hash(secret), role: 'ski_swap.print_bridge' },
});
await prisma.swapPrinter.create({
  data: { orgId: org.id, name: 'Raster smoke printer', bluetoothName: 'M221-RASTER', model: 'm221', paperSize: '62x100', bridgeDeviceId: bridge.id },
});
const station = await prisma.checkinStation.create({
  data: { orgId: org.id, name: 'Raster smoke station', code: 'Z', bridgeDeviceId: bridge.id },
});

const tokenFor = (clientId) =>
  fetch(`${BASE}/auth/device/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret: secret }),
  }).then(unwrap).then((t) => ({ authorization: `Bearer ${t.accessToken}` }));
const H = await tokenFor(`${SEED}-bridge`);
const OTHER = await tokenFor(`${SEED}-stranger`);

const claim = (query) =>
  fetch(`${BASE}/devices/me/print-jobs/claim?limit=1&wait=0${query}`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}',
  }).then(unwrap);
// Asks for compression on purpose: nothing on the path may honour it.
const raster = (id, headers = H) =>
  fetch(`${BASE}/devices/me/print-jobs/${id}/raster`, { headers: { ...headers, 'accept-encoding': 'gzip, deflate, br' } });

// ─── The claim without the payload ───────────────────────────────────────────
await prisma.printJob.create({ data: { orgId: org.id, stationId: station.id, kind: 'calibration' } });
const bare = await claim('&payload=omit');
const job = bare.jobs?.[0];
ok('a claim with payload=omit carries no base64', !!job && !('payload' in job), JSON.stringify(job));
ok('...and says how big the raster is: 62 × 100 on an M221', job?.rasterBytes === 56_448 && job?.widthBytes === 72,
  `rasterBytes ${job?.rasterBytes}, widthBytes ${job?.widthBytes}`);

const before = await prisma.printJob.findUnique({ where: { id: job.id } });

// ─── The bytes ───────────────────────────────────────────────────────────────
const res = await raster(job.id);
const body = Buffer.from(await res.arrayBuffer());
ok('the raster comes back as bytes', res.status === 200 && res.headers.get('content-type') === 'application/octet-stream',
  `HTTP ${res.status} ${res.headers.get('content-type')}`);
ok('...with an exact Content-Length, matching the claim', Number(res.headers.get('content-length')) === job.rasterBytes &&
  body.length === job.rasterBytes, `header ${res.headers.get('content-length')}, body ${body.length}`);
ok('...not chunked', !res.headers.get('transfer-encoding'), String(res.headers.get('transfer-encoding')));
ok('...and not compressed, though the request asked for it', !res.headers.get('content-encoding'),
  String(res.headers.get('content-encoding')));
ok('...a whole number of rows', body.length % job.widthBytes === 0, `${body.length / job.widthBytes} rows`);

const again = Buffer.from(await (await raster(job.id)).arrayBuffer());
ok('a second fetch in the same claim is the same bytes', again.equals(body));

// ─── In pieces ───────────────────────────────────────────────────────────────
// A TLS record is no larger than what is sent, so 4 KB pieces cap every record
// at 4 KB whatever the connection has been doing — which is what lets a bridge
// with 17 KB to spare decrypt them.
const ranged = (id, range) => fetch(`${BASE}/devices/me/print-jobs/${id}/raster`, {
  headers: { ...H, range, 'accept-encoding': 'gzip, deflate, br' },
});
ok('a whole fetch says ranges are welcome', res.headers.get('accept-ranges') === 'bytes', String(res.headers.get('accept-ranges')));
const tag = res.headers.get('etag');
ok('...and carries a tag for the render', !!tag, String(tag));

const PIECE = 4096;
const assembled = Buffer.alloc(job.rasterBytes);
const statuses = [];
let piecesOk = true;
for (let start = 0; start < job.rasterBytes; start += PIECE) {
  const end = Math.min(start + PIECE, job.rasterBytes) - 1;
  const part = await ranged(job.id, `bytes=${start}-${start + PIECE - 1}`);
  const bytes = Buffer.from(await part.arrayBuffer());
  statuses.push(part.status);
  piecesOk &&= part.status === 206 &&
    part.headers.get('content-range') === `bytes ${start}-${end}/${job.rasterBytes}` &&
    Number(part.headers.get('content-length')) === end - start + 1 && bytes.length === end - start + 1 &&
    !part.headers.get('transfer-encoding') && !part.headers.get('content-encoding') &&
    part.headers.get('etag') === tag && part.headers.get('content-type') === 'application/octet-stream';
  bytes.copy(assembled, start);
}
ok(`the raster comes in ${statuses.length} pieces of 206, each exactly the part asked for`, piecesOk,
  statuses.join(' '));
ok('...which put together are the whole raster, byte for byte', assembled.equals(body));

const lastPiece = await ranged(job.id, `bytes=53248-57343`);
ok('a range past the end is clamped to the last byte, not refused',
  lastPiece.status === 206 && lastPiece.headers.get('content-range') === `bytes 53248-56447/${job.rasterBytes}` &&
    Number(lastPiece.headers.get('content-length')) === 3200,
  `${lastPiece.status} ${lastPiece.headers.get('content-range')} ${lastPiece.headers.get('content-length')}`);

const beyond = await ranged(job.id, `bytes=${job.rasterBytes}-${job.rasterBytes + 4095}`);
ok('a range that starts past the end is 416, naming the size',
  beyond.status === 416 && beyond.headers.get('content-range') === `bytes */${job.rasterBytes}`,
  `${beyond.status} ${beyond.headers.get('content-range')}`);

const several = await ranged(job.id, 'bytes=0-99,200-299');
ok('several ranges at once get the whole raster', several.status === 200 &&
  Buffer.from(await several.arrayBuffer()).equals(body), `HTTP ${several.status}`);

const after = await prisma.printJob.findUnique({ where: { id: job.id } });
ok('fetching changes nothing about the job — attempts, lease, status',
  after.attempts === before.attempts && after.claimUntil.getTime() === before.claimUntil.getTime() &&
    after.status === 'claimed' && after.claimToken === before.claimToken,
  `attempts ${before.attempts}→${after.attempts}`);

// ─── Who may fetch it ────────────────────────────────────────────────────────
const theirs = await raster(job.id, OTHER);
ok('another bridge gets 404, not 403 — it learns nothing', theirs.status === 404, `HTTP ${theirs.status}`);
const missing = await raster('no-such-job');
ok('a job that does not exist is 404', missing.status === 404, `HTTP ${missing.status}`);
const errorBody = await missing.json().catch(() => null);
ok('...with the usual JSON error envelope', errorBody?.success === false, JSON.stringify(errorBody));

const unclaimed = await prisma.printJob.create({ data: { orgId: org.id, stationId: station.id, kind: 'calibration' } });
const notYet = await raster(unclaimed.id);
ok('a job this bridge has not claimed is 404', notYet.status === 404, `HTTP ${notYet.status}`);
await prisma.printJob.delete({ where: { id: unclaimed.id } });

await fetch(`${BASE}/devices/me/print-jobs/${job.id}/ack`, { method: 'POST', headers: H });
const settled = await raster(job.id);
ok('once acknowledged it is 410 — drop it, do not retry', settled.status === 410, `HTTP ${settled.status}`);
const settledPiece = await ranged(job.id, 'bytes=0-4095');
ok('...and so is a piece of it', settledPiece.status === 410, `HTTP ${settledPiece.status}`);

// ─── The inline claim is unchanged ───────────────────────────────────────────
await prisma.printJob.create({ data: { orgId: org.id, stationId: station.id, kind: 'calibration' } });
const inline = await claim('');
const inlineJob = inline.jobs?.[0];
const decoded = inlineJob?.payload ? Buffer.from(inlineJob.payload, 'base64') : null;
ok('a claim without payload=omit still carries the base64', !!decoded && decoded.length === inlineJob.rasterBytes,
  `payload ${decoded?.length} bytes, rasterBytes ${inlineJob?.rasterBytes}`);
const fetched = Buffer.from(await (await raster(inlineJob.id)).arrayBuffer());
ok('...and the raster endpoint returns those same bytes', !!decoded && fetched.equals(decoded));

// A lapsed lease, set directly rather than waited out.
await prisma.printJob.update({ where: { id: inlineJob.id }, data: { claimUntil: new Date(Date.now() - 1000) } });
const expired = await raster(inlineJob.id);
ok('an expired claim is 410', expired.status === 410, `HTTP ${expired.status}`);

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.printJob.deleteMany({ where: { stationId: station.id } });
await prisma.checkinStation.delete({ where: { id: station.id } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: 'Raster smoke printer' } });
await prisma.device.deleteMany({ where: { clientId: { startsWith: SEED } } });
await prisma.$disconnect();

console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
