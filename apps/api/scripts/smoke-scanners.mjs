// Provisioning a barcode scanner and binding it to a bridge, against a running
// API and real database.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-scanners.mjs
//
// Sign-in endpoints are throttled to five attempts a minute, so back-to-back
// runs return 429 and look like a regression. Leave a minute between them.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const org = await smokeOrg(prisma);

// ─── Fixtures ────────────────────────────────────────────────────────────────
await prisma.swapScanner.deleteMany({ where: { orgId: org.id } });
await prisma.device.deleteMany({ where: { orgId: org.id, name: { in: ['Scanner smoke bridge', 'Scanner smoke bridge 2', 'Scanner smoke iPad'] } } });

async function device(name, role) {
  return prisma.device.create({
    data: {
      id: createId(), orgId: org.id, name, role,
      clientId: createId(), secretHash: 'x',
    },
  });
}

const bridge = await device('Scanner smoke bridge', 'ski_swap.print_bridge');
const otherBridge = await device('Scanner smoke bridge 2', 'ski_swap.print_bridge');
const iPad = await device('Scanner smoke iPad', 'ski_swap.staff_check_in');

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const token = await smokeSession(prisma, BASE, staff, unwrap);
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const url = `${BASE}/orgs/${org.id}/ski-swap/scanners`;
const post = (body) => fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
const patch = (id, body) => fetch(`${url}/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });

// ─── Provisioning ────────────────────────────────────────────────────────────

const empty = await fetch(url, { headers: H }).then(unwrap);
ok('an org starts with no scanners', Array.isArray(empty) && empty.length === 0, String(empty.length));

const created = await post({ name: 'Front counter', bluetoothName: 'BCST-23-A1B2' }).then(unwrap);
ok('a scanner can be provisioned', created.name === 'Front counter', JSON.stringify(created));
ok('and stores the advertised name verbatim', created.bluetoothName === 'BCST-23-A1B2',
   created.bluetoothName);
ok('and starts bound to nothing', created.bridgeDeviceId === null, String(created.bridgeDeviceId));

// The same peripheral twice gives two records fighting over one link, and the
// second silently never works.
const dupe = await post({ name: 'Second try', bluetoothName: 'BCST-23-A1B2' });
const dupeBody = await dupe.json();
ok('the same Bluetooth name cannot be provisioned twice', dupe.status === 409, String(dupe.status));
ok('and the refusal names what already holds it',
   (dupeBody.error ?? '').includes('Front counter'), String(dupeBody.error));

// ─── Binding to a bridge ─────────────────────────────────────────────────────

const bound = await patch(created.id, { bridgeDeviceId: bridge.id }).then(unwrap);
ok('a scanner binds to a bridge', bound.bridgeDeviceId === bridge.id, String(bound.bridgeDeviceId));

const second = await post({ name: 'Back table', bluetoothName: 'BCST-23-C3D4' }).then(unwrap);
const contested = await patch(second.id, { bridgeDeviceId: bridge.id });
const contestedBody = await contested.json();
ok('a second scanner cannot take a bridge that holds one', contested.status === 409,
   String(contested.status));
ok('and the refusal says which scanner is in the way',
   (contestedBody.error ?? '').includes('Front counter'), String(contestedBody.error));

const wrongRole = await patch(second.id, { bridgeDeviceId: iPad.id });
ok('only a print bridge may drive a scanner', wrongRole.status === 400, String(wrongRole.status));

const elsewhere = await patch(second.id, { bridgeDeviceId: otherBridge.id }).then(unwrap);
ok('a free bridge takes the second scanner', elsewhere.bridgeDeviceId === otherBridge.id,
   String(elsewhere.bridgeDeviceId));

// A bridge holds two different peripherals at once; one link says nothing about
// the other.
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, bluetoothName: 'SCAN-SMOKE-PRN' } });
const printer = await prisma.swapPrinter.create({
  data: {
    id: createId(), orgId: org.id, name: 'Scanner smoke printer',
    bluetoothName: 'SCAN-SMOKE-PRN', paperSize: '50x30', bridgeDeviceId: bridge.id,
    updatedAt: new Date(),
  },
});
const stillBound = await fetch(url, { headers: H }).then(unwrap);
ok('a bridge can hold a printer and a scanner at once',
   stillBound.find((s) => s.id === created.id)?.bridgeDeviceId === bridge.id,
   String(stillBound.find((s) => s.id === created.id)?.bridgeDeviceId));

const released = await patch(created.id, { bridgeDeviceId: null }).then(unwrap);
ok('a scanner can be released', released.bridgeDeviceId === null, String(released.bridgeDeviceId));

// ─── Renaming and removal ────────────────────────────────────────────────────

const renamed = await patch(created.id, { name: 'Front counter (spare)' }).then(unwrap);
ok('a scanner can be renamed', renamed.name === 'Front counter (spare)', renamed.name);

const gone = await fetch(`${url}/${second.id}`, { method: 'DELETE', headers: H });
ok('a scanner can be removed', gone.status === 204, String(gone.status));
const remaining = await fetch(url, { headers: H }).then(unwrap);
ok('and is gone from the list', remaining.length === 1, String(remaining.length));

const missing = await patch('nosuchscanner', { name: 'x' });
ok('an unknown scanner is a 404', missing.status === 404, String(missing.status));

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.swapPrinter.delete({ where: { id: printer.id } });
await prisma.swapScanner.deleteMany({ where: { orgId: org.id } });
await prisma.device.deleteMany({ where: { id: { in: [bridge.id, otherBridge.id, iPad.id] } } });
await prisma.$disconnect();
