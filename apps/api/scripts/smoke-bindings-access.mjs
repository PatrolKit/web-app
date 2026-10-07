// Who may read the indemnified-bindings lookup (Plan 44 D10), against a
// running API. Read-only on the registry: it signs in, asks, and cleans up the
// people and the device it made. Test org only.
//
//   node apps/api/scripts/smoke-bindings-access.mjs
//
// Staff and a check-in iPad are answered; a seller, a member with no ski-swap
// permission, is refused, as is a device of another role. A seller is the
// case that matters: a business seller is a retail shop, exactly who NSSRA's
// members-only list is kept from.

import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (l, c, e = '') => { if (!c) failures++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`); };

const org = await smokeOrg(prisma);
const SELLER = 'bindings-seller@patrolkit.invalid';
const DEVICES = ['Bindings smoke iPad', 'Bindings smoke bridge'];
await prisma.device.deleteMany({ where: { orgId: org.id, name: { in: DEVICES } } });
const old = await prisma.user.findFirst({ where: { email: SELLER } });
if (old) await prisma.user.delete({ where: { id: old.id } });

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:report', 'org:read']);
const staffToken = await smokeSession(prisma, BASE, staff, unwrap);

const sellerUser = await prisma.user.create({ data: { id: createId(), email: SELLER, firstName: 'Bindings', lastName: 'Seller' } });
const m = await prisma.membership.create({ data: { id: createId(), userId: sellerUser.id, orgId: org.id, updatedAt: new Date() } });
await prisma.sellerProfile.create({ data: { id: createId(), membershipId: m.id, businessName: 'Bindings Smoke Shop' } });
const sellerToken = await smokeSession(prisma, BASE, sellerUser, unwrap);

async function deviceToken(name, role) {
  const secret = createId();
  const clientId = createId();
  await prisma.device.create({ data: { id: createId(), orgId: org.id, name, role, clientId, secretHash: await argon2.hash(secret, { type: argon2.argon2id }) } });
  return (await fetch(`${BASE}/auth/device/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret: secret }),
  }).then(unwrap)).accessToken;
}
const ipadToken = await deviceToken(DEVICES[0], 'ski_swap.staff_check_in');
const bridgeToken = await deviceToken(DEVICES[1], 'ski_swap.print_bridge');

const LOOKUP = `/orgs/${org.id}/ski-swap/bindings/indemnification`;
const ask = (token, path) => fetch(`${BASE}${LOOKUP}${path}`, { headers: { authorization: `Bearer ${token}` } });

for (const path of ['/manufacturers', '/search?q=marker']) {
  const s = await ask(staffToken, path);
  ok(`staff read ${path}`, s.status === 200, `HTTP ${s.status}`);
  const i = await ask(ipadToken, path);
  ok(`...and so does a check-in iPad`, i.status === 200, `HTTP ${i.status}`);
  const sel = await ask(sellerToken, path);
  ok(`...a seller is refused`, sel.status === 403, `HTTP ${sel.status}`);
  const b = await ask(bridgeToken, path);
  ok(`...as is a device of another role`, b.status === 403, `HTTP ${b.status}`);
}
const none = await fetch(`${BASE}${LOOKUP}/manufacturers`);
ok('nobody signed in is refused', none.status === 401, `HTTP ${none.status}`);

await prisma.device.deleteMany({ where: { orgId: org.id, name: { in: DEVICES } } });
await prisma.user.delete({ where: { id: sellerUser.id } });
await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
