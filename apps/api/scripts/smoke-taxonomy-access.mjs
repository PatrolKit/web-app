// Who may read the item tree.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-taxonomy-access.mjs
//
// A seller checking themselves in has no ski-swap permissions — they are a
// membership with a seller profile. The item form cannot start without this
// call, and a refusal here surfaced as "No item categories are set up yet",
// which sends somebody to configure a tree that was already there.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
const ok = (l, c, e = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`);

const org = await smokeOrg(prisma);
const url = `${BASE}/orgs/${org.id}/ski-swap/taxonomy`;

await prisma.user.deleteMany({ where: { email: 'tax-seller@patrolkit.invalid' } });
const user = await prisma.user.create({ data: {
  id: createId(), email: 'tax-seller@patrolkit.invalid', firstName: 'Plain', lastName: 'Seller' } });
const membership = await prisma.membership.create({ data: {
  id: createId(), userId: user.id, orgId: org.id, updatedAt: new Date() } });
await prisma.sellerProfile.create({ data: { id: createId(), membershipId: membership.id } });

const sellerToken = await smokeSession(prisma, BASE, user, unwrap);
const res = await fetch(url, { headers: { authorization: `Bearer ${sellerToken}` } });
ok('a seller with no ski-swap permissions can read the tree', res.status === 200, String(res.status));

const tree = await res.json().then((b) => b?.data ?? b);
ok('and it has categories to offer them',
   Array.isArray(tree.categories) && tree.categories.length > 0,
   `${tree.categories?.length} categories`);

// Staff still read it, and the tree is the same tree.
const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:report']);
const staffToken = await smokeSession(prisma, BASE, staff, unwrap);
const asStaff = await fetch(url, { headers: { authorization: `Bearer ${staffToken}` } }).then(unwrap);
ok('staff read the same tree', asStaff.categories.length === tree.categories.length,
   `${asStaff.categories.length} vs ${tree.categories.length}`);

// Membership is still the gate — this is org reference data, not public.
const anon = await fetch(url);
ok('and no token is still refused', anon.status === 401, String(anon.status));

// Writing is untouched: a seller cannot curate the tree.
const write = await fetch(`${url}/values`, {
  method: 'POST',
  headers: { authorization: `Bearer ${sellerToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ parentId: tree.categories[0].id, label: 'Nope' }),
});
ok('a seller still cannot add to the tree', write.status === 403, String(write.status));

await prisma.user.delete({ where: { id: user.id } });
await prisma.$disconnect();
