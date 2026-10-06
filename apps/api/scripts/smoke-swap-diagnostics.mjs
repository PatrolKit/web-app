// Swap diagnostics end to end (Plan 41), against the stub Square catalog.
//
//   PAYOUTS_STUB=1 SMOKE_CATALOG_FILE=/tmp/smoke-catalog.json PORT=4001 node apps/api/dist/src/main.js &
//   SMOKE_CATALOG_FILE=/tmp/smoke-catalog.json node apps/api/scripts/smoke-swap-diagnostics.mjs
//
// The API and this script share the catalog file: the script plays Square,
// including a fix made by hand. Test org only, and never against real Square.

import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const CATALOG = process.env.SMOKE_CATALOG_FILE;
if (!CATALOG) {
  console.error('Set SMOKE_CATALOG_FILE, the same file the stubbed API reads.');
  process.exit(1);
}

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
const ok = (l, c, e = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`);

const org = await smokeOrg(prisma);
const TITLE = 'Diagnostics smoke swap';
const EMAIL = 'diag-seller@patrolkit.invalid';
await prisma.swapItem.deleteMany({ where: { orgId: org.id, swap: { title: TITLE } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: TITLE } });
const oldSeller = await prisma.user.findFirst({ where: { email: EMAIL } });
if (oldSeller) await prisma.user.delete({ where: { id: oldSeller.id } });

const swap = await prisma.skiSwap.create({
  data: { orgId: org.id, slug: `dg${Date.now().toString(36)}`, title: TITLE, squareCategoryId: 'diag-cat', locationId: 'diag-loc', skuPrefix: 'DG', active: true, activeSkuPrefix: 'DG' },
});
const u = await prisma.user.create({ data: { id: createId(), email: EMAIL, firstName: 'Diag', lastName: 'Seller' } });
const m = await prisma.membership.create({ data: { id: createId(), userId: u.id, orgId: org.id, updatedAt: new Date() } });
const seller = await prisma.sellerProfile.create({ data: { id: createId(), membershipId: m.id } });

const item = (sku, over = {}) => prisma.swapItem.create({
  data: {
    swapId: swap.id, orgId: org.id, sellerId: seller.id, sku, liveSku: sku, name: 'Red Skis', priceCents: 4500,
    originalQuantity: 1, consignedAt: new Date(), squareItemId: `sq-${sku}`, squareVariationId: `sv-${sku}`, ...over,
  },
});
const sq = (sku, over = {}) => ({
  itemId: `sq-${sku}`, variationId: `sv-${sku}`, sku, name: 'Red Skis', description: null,
  pricing: { type: 'fixed', cents: 4500 }, version: '1', updatedAt: null, categoryId: 'diag-cat', ...over,
});

// One of each issue (D2), and one fixed by hand later.
await item('DG-0001', { squareItemId: null, squareVariationId: null }); // only in PatrolKit
await item('DG-0002', { priceCents: 5000 });                           // price differs
await item('DG-0003', { squareItemId: null, squareVariationId: null }); // not linked
await item('DG-0004');                                                  // twice in Square
await item('DG-0006', { deletedAt: new Date(), liveSku: null, squareItemId: null, squareVariationId: null }); // deleted, still in Square
await item('DG-0007', { name: 'Blue Skis' });                          // name differs: left as is
await item('DG-0008', { priceCents: 6000 });                           // price differs: fixed by hand
fs.writeFileSync(CATALOG, JSON.stringify([
  sq('DG-0002'), sq('DG-0003'), sq('DG-0004'), sq('DG-0004', { itemId: 'sq-dup', variationId: 'sv-dup' }),
  sq('DG-0005', { name: 'Sled', pricing: { type: 'fixed', cents: 2000 } }), // only in Square
  sq('DG-0006'), sq('DG-0007'), sq('DG-0008'),
], null, 2));

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const token = await smokeSession(prisma, BASE, staff, unwrap);
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const D = `${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/diagnostics`;

async function run() {
  await fetch(D, { method: 'POST', headers: H });
  for (let i = 0; i < 40; i++) {
    const latest = await fetch(`${D}/latest`, { headers: H }).then(unwrap);
    if (latest?.status !== 'running') return latest;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('The run never finished');
}
const find = (r, sku, kind, field = null) => r.issues.find((i) => i.sku === sku && i.kind === kind && i.field === field);
const choose = (issue, body) => fetch(`${D}/issues/${issue.id}`, { method: 'POST', headers: H, body: JSON.stringify(body) }).then(unwrap);

const first = await run();
ok('a run finishes', first.status === 'done', first.status);
const expected = [
  ['DG-0001', 'only_ours'], ['DG-0002', 'differs', 'price'], ['DG-0003', 'not_linked'], ['DG-0004', 'twice'],
  ['DG-0005', 'only_square'], ['DG-0006', 'only_square'], ['DG-0007', 'differs', 'name'], ['DG-0008', 'differs', 'price'],
];
for (const [sku, kind, field] of expected) ok(`finds ${sku} ${kind}${field ? ` (${field})` : ''}`, !!find(first, sku, kind, field ?? null));
ok('says DG-0006 was one of our deleted items', find(first, 'DG-0006', 'only_square')?.ours?.deleted === true);

// Each choice once (D3).
ok('Copy to Square', (await choose(find(first, 'DG-0001', 'only_ours'), { choice: 'copy_to_square' })).state === 'applied');
ok('Use Square’s price', (await choose(find(first, 'DG-0002', 'differs', 'price'), { choice: 'use_square' })).state === 'applied');
ok('Link to it', (await choose(find(first, 'DG-0003', 'not_linked'), { choice: 'link' })).state === 'applied');
ok('Keep this copy', (await choose(find(first, 'DG-0004', 'twice'), { choice: 'keep', keepSquareItemId: 'sq-dup' })).state === 'applied');
const copied = await choose(find(first, 'DG-0005', 'only_square'), { choice: 'copy_to_patrolkit', sellerId: seller.id });
ok('Copy to PatrolKit, for a seller', copied.state === 'applied', copied.state === 'applied' ? '' : JSON.stringify(copied));
const gone = find(first, 'DG-0006', 'only_square');
ok('Copy to PatrolKit, restoring the deleted item', (await choose(gone, { choice: 'copy_to_patrolkit', restoreItemId: gone.ours.itemId })).state === 'applied');
ok('Mark resolved, left as is', (await choose(find(first, 'DG-0007', 'differs', 'name'), { choice: 'resolve' })).state === 'left');

// Fixed by hand in "Square", then marked resolved (D5).
fs.writeFileSync(CATALOG, JSON.stringify(JSON.parse(fs.readFileSync(CATALOG, 'utf8'))
  .map((e) => (e.sku === 'DG-0008' ? { ...e, pricing: { type: 'fixed', cents: 6000 }, version: '2' } : e)), null, 2));
ok('Mark resolved, fixed by hand', (await choose(find(first, 'DG-0008', 'differs', 'price'), { choice: 'resolve' })).state === 'fixed');

const second = await run();
const open = second.issues.filter((i) => i.state === 'open').map((i) => `${i.sku} ${i.kind}`);
ok('a second run shows nothing left', open.length === 0, open.join(', '));
ok('DG-0002 took Square’s price', (await prisma.swapItem.findFirst({ where: { swapId: swap.id, sku: 'DG-0002' } })).priceCents === 4500);
ok('DG-0005 is ours now, linked', (await prisma.swapItem.findFirst({ where: { swapId: swap.id, sku: 'DG-0005', deletedAt: null } }))?.squareItemId === 'sq-DG-0005');
const audited = await prisma.auditLog.count({ where: { orgId: org.id, action: 'ski_swap.diagnostics.applied', metadata: { path: '$.swapId', equals: swap.id } } });
ok('every choice audited', audited === 8, `${audited} of 8`);

await prisma.auditLog.deleteMany({ where: { orgId: org.id, action: 'ski_swap.diagnostics.applied', metadata: { path: '$.swapId', equals: swap.id } } });
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.user.delete({ where: { id: u.id } });
await prisma.$disconnect();
