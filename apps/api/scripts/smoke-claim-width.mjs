// The width contract with the bridge.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-claim-width.mjs
//
// The bridge divides a job's payload by `widthBytes` to find its height and
// refuses a remainder, so these two numbers have to agree or the job is dropped
// before it ever reaches the printer — which is exactly how a 62 x 100 raster
// failed against a hard-coded 50.
//
// The figures below are pinned on both sides: webprinter_esp32's host suite
// builds the same label through its own ESC/POS builder and asserts 56,448
// raster bytes. If this script and that one disagree, one of the two repos has
// moved and the other has not.
import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import argon2 from 'argon2';
import { smokeOrg } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
const ok = (l, c, e = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`);

const org = await smokeOrg(prisma);
await prisma.printJob.deleteMany({ where: { orgId: org.id } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'M221 claim station' } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: 'M221 claim printer' } });
await prisma.device.deleteMany({ where: { orgId: org.id, name: 'M221 claim bridge' } });

const clientId = createId(), clientSecret = createId();
const bridge = await prisma.device.create({ data: {
  id: createId(), orgId: org.id, name: 'M221 claim bridge', role: 'ski_swap.print_bridge',
  clientId, secretHash: await argon2.hash(clientSecret, { type: argon2.argon2id }) } });
const printer = await prisma.swapPrinter.create({ data: {
  id: createId(), orgId: org.id, name: 'M221 claim printer', bluetoothName: 'Q454E62S2530017',
  model: 'm221', paperSize: '62x100', marginTop: 16, marginBottom: 16, marginLeft: 16, marginRight: 16,
  bridgeDeviceId: bridge.id, updatedAt: new Date() } });
const station = await prisma.checkinStation.create({ data: {
  id: createId(), orgId: org.id, name: 'M221 claim station', code: 'M',
  bridgeDeviceId: bridge.id, updatedAt: new Date() } });

const { accessToken } = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId, clientSecret }) }).then(unwrap);
const H = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };

await prisma.printJob.create({ data: {
  orgId: org.id, stationId: station.id, printerId: printer.id, kind: 'calibration' } });

const claim = await fetch(`${BASE}/devices/me/print-jobs/claim`, { method: 'POST', headers: H }).then(unwrap);
const job = claim.jobs[0];
const bytes = Buffer.from(job.payload, 'base64');

ok('an M221 job declares 72-byte rows', job.widthBytes === 72, String(job.widthBytes));
ok('and carries the 56,448 bytes the firmware pins', bytes.length === 56448, String(bytes.length));
ok('which is a whole number of those rows', bytes.length % job.widthBytes === 0,
   `${bytes.length / job.widthBytes} rows`);
ok('784 rows — 100 mm less the feed the bridge adds', bytes.length / job.widthBytes === 784,
   String(bytes.length / job.widthBytes));

await prisma.printJob.deleteMany({ where: { orgId: org.id } });
await prisma.checkinStation.delete({ where: { id: station.id } });
await prisma.swapPrinter.delete({ where: { id: printer.id } });
await prisma.device.delete({ where: { id: bridge.id } });
await prisma.$disconnect();
