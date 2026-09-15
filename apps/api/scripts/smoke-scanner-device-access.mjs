// Who may read the scanner list, and who may change it.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-scanner-device-access.mjs
//
// Plan 13 (iOS) asked for the check-in iPad to list scanners. The thing worth
// proving is not that the list opened — it is that nothing else did. A device
// clears `PermissionsGuard` on its role alone, so `@RequirePermissions` is never
// consulted for it: if the role decorator sat on the controller instead of the
// handler, a check-in iPad could delete scanners and every assertion about
// `ski_swap:admin` would still read as if it were holding.

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
await prisma.swapScanner.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Access smoke' } } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Access smoke' } } });
await prisma.device.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Access smoke' } } });

/** A device of the given role, with credentials the token exchange will accept. */
async function deviceToken(name, role) {
  const clientId = createId();
  const clientSecret = createId();
  await prisma.device.create({
    data: {
      id: createId(), orgId: org.id, name, role, clientId,
      secretHash: await argon2.hash(clientSecret, { type: argon2.argon2id }),
    },
  });
  const res = await fetch(`${BASE}/auth/device/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  }).then(unwrap);
  return res.accessToken;
}

const iPad = await deviceToken('Access smoke iPad', 'ski_swap.staff_check_in');
const bridge = await deviceToken('Access smoke bridge', 'ski_swap.print_bridge');

const IPAD = { authorization: `Bearer ${iPad}`, 'content-type': 'application/json' };
const BRIDGE = { authorization: `Bearer ${bridge}`, 'content-type': 'application/json' };

const scanner = await prisma.swapScanner.create({
  data: {
    id: createId(), orgId: org.id, name: 'Access smoke scanner',
    bluetoothName: 'HPRT-ACCESS-SMOKE', updatedAt: new Date(),
  },
});

const scanners = `${BASE}/orgs/${org.id}/ski-swap/scanners`;

// ─── The ask: the iPad can read the list ─────────────────────────────────────

const listed = await fetch(scanners, { headers: IPAD });
ok('a check-in iPad can list scanners', listed.status === 200, String(listed.status));

const body = await listed.json();
const rows = body?.data ?? body;
ok('and the list is a bare array, not a paged envelope',
   Array.isArray(rows), JSON.stringify(body).slice(0, 120));

const mine = Array.isArray(rows) ? rows.find((s) => s.id === scanner.id) : null;
ok('carrying every field the picker reads',
   !!mine && typeof mine.name === 'string' && typeof mine.bluetoothName === 'string'
   && 'bridgeDeviceId' in mine && 'stationName' in mine,
   JSON.stringify(mine));

// ─── What must NOT have opened along with it ─────────────────────────────────

const created = await fetch(scanners, {
  method: 'POST', headers: IPAD,
  body: JSON.stringify({ name: 'Access smoke intruder', bluetoothName: 'HPRT-INTRUDER' }),
});
ok('a check-in iPad CANNOT create a scanner', created.status === 403, String(created.status));

const patched = await fetch(`${scanners}/${scanner.id}`, {
  method: 'PATCH', headers: IPAD, body: JSON.stringify({ name: 'Renamed by a device' }),
});
ok('a check-in iPad CANNOT rename a scanner', patched.status === 403, String(patched.status));

const deleted = await fetch(`${scanners}/${scanner.id}`, { method: 'DELETE', headers: IPAD });
ok('a check-in iPad CANNOT delete a scanner', deleted.status === 403, String(deleted.status));

const survived = await prisma.swapScanner.findUnique({ where: { id: scanner.id } });
ok('and the scanner is still there, unrenamed',
   survived !== null && survived.name === 'Access smoke scanner', String(survived?.name));

// The role is the whole check, so the wrong role must be refused.
const wrongRole = await fetch(scanners, { headers: BRIDGE });
ok('a print bridge is not a check-in iPad and cannot list scanners',
   wrongRole.status === 403, String(wrongRole.status));

const anonymous = await fetch(scanners);
ok('and no token at all is a 401', anonymous.status === 401, String(anonymous.status));

// ─── The same question, asked of the printer routes ──────────────────────────
// PrinterController carries its role decorator on the class. If that reaches the
// write routes, this is a live hole rather than a hypothetical one.

const printers = `${BASE}/orgs/${org.id}/ski-swap/printers`;

const printerListed = await fetch(printers, { headers: IPAD });
ok('a check-in iPad can still list printers, which is what it actually needs',
   printerListed.status === 200, String(printerListed.status));

const printerCreate = await fetch(printers, {
  method: 'POST', headers: IPAD,
  body: JSON.stringify({ name: 'Access smoke intruder printer', bluetoothName: 'Q-INTRUDER', paperSize: '50x30' }),
});
ok('a check-in iPad CANNOT create a printer', printerCreate.status === 403, String(printerCreate.status));

const printer = await prisma.swapPrinter.create({
  data: {
    id: createId(), orgId: org.id, name: 'Access smoke printer',
    bluetoothName: 'Q-ACCESS-SMOKE', paperSize: '50x30', updatedAt: new Date(),
  },
});

// These two took no @CurrentUser, so nothing downstream crashed to mask them:
// before the role decorator moved off the class, both went through.
const printerPatch = await fetch(`${printers}/${printer.id}`, {
  method: 'PATCH', headers: IPAD, body: JSON.stringify({ name: 'Renamed by a device' }),
});
ok('a check-in iPad CANNOT rename a printer', printerPatch.status === 403, String(printerPatch.status));

const printerDelete = await fetch(`${printers}/${printer.id}`, { method: 'DELETE', headers: IPAD });
ok('a check-in iPad CANNOT delete a printer', printerDelete.status === 403, String(printerDelete.status));

const printerSurvived = await prisma.swapPrinter.findUnique({ where: { id: printer.id } });
ok('and the printer is still there, unrenamed',
   printerSurvived !== null && printerSurvived.name === 'Access smoke printer',
   String(printerSurvived?.name));

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.swapScanner.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Access smoke' } } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Access smoke' } } });
await prisma.device.deleteMany({ where: { orgId: org.id, name: { startsWith: 'Access smoke' } } });
await prisma.$disconnect();
