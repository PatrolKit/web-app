// Item tombstones (iOS plan 15), against a running API and database.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-item-tombstones.mjs
//
// An item deleted on the server used to take about twenty-two minutes to leave
// an iPad, because absence is the only evidence of a deletion and the only way
// to see it is to ask for every item and notice what did not come back. Items
// are soft-deleted now, so the removal rides the delta like a seller's does.
//
// The four things worth proving against a real database, none of which a unit
// test can reach:
//
//   - the delta carries the tombstone, and a plain list does not;
//   - the deleted item's ticket number can be issued again, which is the
//     unique index actually releasing it rather than a query pretending to;
//   - a withdrawn tag scans as nothing;
//   - a seller cannot withdraw an item once its tag is printed.
//
// Sign-in is throttled to five a minute and this script signs in twice — once
// as staff, once as the seller, because the guard on withdrawing a tagged item
// is only observable from the seller's own session. Two runs inside a minute
// will therefore hit the limit; leave a minute between them.
//
// Everything below is about what happens to an item after it is deleted, so the
// first thing asserted is that the item existed and was found before the delete.
// A delete of nothing tombstones nothing and every later check would pass.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

const org = await smokeOrg(prisma);

// ─── Fixtures ────────────────────────────────────────────────────────────────

const prior = await prisma.skiSwap.findMany({
  where: { orgId: org.id, title: 'Tombstone smoke swap' }, select: { id: true },
});
for (const s of prior) await prisma.swapItem.deleteMany({ where: { swapId: s.id } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Tombstone smoke swap' } });

const SELLER_PHONE = '+15550197301';
const existing = await prisma.user.findFirst({ where: { phone: SELLER_PHONE } });
if (existing) await prisma.user.delete({ where: { id: existing.id } });

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, title: 'Tombstone smoke swap', squareCategoryId: 'tomb',
    locationId: '', skuPrefix: 'TMB', active: true, activeSkuPrefix: 'TMB',
    legacyTicketsEnabled: true,
  },
});

const sellerUser = await prisma.user.create({
  data: {
    id: createId(), firstName: 'Tombstone', lastName: 'Seller',
    phone: SELLER_PHONE, verifiedPhone: SELLER_PHONE, phoneVerifiedAt: new Date(),
    email: 'tombstone-seller@patrolkit.invalid',
    verifiedEmail: 'tombstone-seller@patrolkit.invalid', emailVerifiedAt: new Date(),
  },
});
const sellerMembership = await prisma.membership.create({
  data: { id: createId(), userId: sellerUser.id, orgId: org.id, updatedAt: new Date() },
});
const sellerProfile = await prisma.sellerProfile.create({
  data: { id: createId(), membershipId: sellerMembership.id },
});

const TICKET = '77001';
const item = await prisma.swapItem.create({
  data: {
    id: createId(), swapId: swap.id, orgId: org.id, sellerId: sellerProfile.id,
    name: 'Withdrawn skis', sku: TICKET, liveSku: TICKET, priceCents: 4500,
    originalQuantity: 1, consignedAt: new Date(),
  },
});
const keeper = await prisma.swapItem.create({
  data: {
    id: createId(), swapId: swap.id, orgId: org.id, sellerId: sellerProfile.id,
    name: 'Kept poles', sku: '77002', liveSku: '77002', priceCents: 2000,
    originalQuantity: 1, consignedAt: new Date(),
  },
});

const { user: staff } = await smokeStaff(prisma, org, [
  'ski_swap:admin', 'ski_swap:manage', 'ski_swap:report', 'org:read',
]);
const token = await smokeSession(prisma, BASE, staff, unwrap);
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });

const sellerToken = await smokeSession(prisma, BASE, sellerUser, unwrap);
const sellerApi = (p, init = {}) => fetch(`${BASE}${p}`, {
  ...init,
  headers: { authorization: `Bearer ${sellerToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
});

const ITEMS = `/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`;
const before = new Date(Date.now() - 60_000).toISOString();

console.log('\n── Before the delete ─────────────────────────────────────────');

const listed = await api(ITEMS).then(unwrap);
ok('the swap has both items to start with',
  listed.total === 2, `got ${listed.total}`);
ok('...and the one about to go is findable by its tag',
  (await api(`${ITEMS}/by-sku/${TICKET}`)).status === 200);
if (listed.total !== 2) await finish();

console.log('\n── Deleting ──────────────────────────────────────────────────');

const deleted = await api(`${ITEMS}/${item.id}`, { method: 'DELETE' });
ok('deleting an item answers 204', deleted.status === 204, `HTTP ${deleted.status}`);

const row = await prisma.swapItem.findUnique({ where: { id: item.id } });
ok('the row is still there, which is the whole point', !!row);
ok('...marked deleted', !!row?.deletedAt);
ok('...keeping the sku the tag says', row?.sku === TICKET);
ok('...and releasing the number the index watches', row?.liveSku === null);

console.log('\n── What a screen sees, and what a cache sees ─────────────────');

const after = await api(ITEMS).then(unwrap);
ok('a plain list does not show a withdrawn item',
  after.total === 1 && after.items[0].id === keeper.id, `got ${after.total}`);

const delta = await api(`${ITEMS}?updatedSince=${encodeURIComponent(before)}`).then(unwrap);
const tombstone = delta.items.find((i) => i.id === item.id);
ok('a delta carries it, so the iPad hears about it within one sync',
  !!tombstone, `delta had ${delta.items.length} items`);
ok('...and says when it went', !!tombstone?.deletedAt);
ok('...while a live item in the same delta says nothing of the sort',
  delta.items.find((i) => i.id === keeper.id)?.deletedAt === null);

console.log('\n── The ticket goes back in the pile ──────────────────────────');

// The real test of the unique index. Everything above would pass just as well
// if the tombstone were merely being filtered out of queries while still
// holding the number against the index — and a volunteer at a counter would be
// told a ticket is spent on an item that was withdrawn an hour ago.
//
// Through the real create path rather than a direct insert: that path is where
// a counter meets the constraint, and it is the one that used to answer
// "ticket 77001 is already on an item".
const category = await prisma.taxonomyNode.findFirst({
  where: { kind: 'CATEGORY', OR: [{ orgId: null }, { orgId: org.id }] },
  select: { id: true, label: true },
});
ok('the taxonomy has a category to file a re-issued item under', !!category,
  'without one the re-issue below proves nothing about the index');

const reissueBody = JSON.stringify({
  categoryId: category?.id, sku: TICKET, priceCents: 3000, quantity: 1,
  sellerId: sellerProfile.id,
});
const reissue = await api(ITEMS, { method: 'POST', body: reissueBody });
ok('the withdrawn ticket number can be issued again',
  reissue.status === 201 || reissue.status === 200,
  `HTTP ${reissue.status} ${(await reissue.clone().text()).slice(0, 180)}`);

const both = await prisma.swapItem.findMany({ where: { swapId: swap.id, sku: TICKET } });
ok('...leaving one tombstone and one live item on that number',
  both.length === 2 && both.filter((b) => b.liveSku === TICKET).length === 1,
  `${both.length} rows, ${both.filter((b) => b.liveSku === TICKET).length} live`);

// And the index still does its day job: two *live* items cannot share a ticket.
const doubled = await api(ITEMS, { method: 'POST', body: reissueBody });
ok('...while two live items still cannot share one ticket',
  doubled.status === 409, `HTTP ${doubled.status}`);

console.log('\n── What a withdrawn tag does now ─────────────────────────────');

// Re-deleting the reissued item so the tag is unattached again.
const reissued = both.find((b) => b.liveSku === TICKET);
if (reissued) await api(`${ITEMS}/${reissued.id}`, { method: 'DELETE' });

const scanned = await api(`${ITEMS}/by-sku/${TICKET}`);
ok('scanning a withdrawn tag finds nothing rather than a tombstone',
  scanned.status === 404, `HTTP ${scanned.status}`);

console.log('\n── A seller withdrawing their own gear ───────────────────────');

const sellerItems = await sellerApi(`/orgs/${org.id}/ski-swap/seller/me/items`).then(unwrap);
ok('the seller sees only what is left',
  Array.isArray(sellerItems) ? sellerItems.length === 1 : sellerItems.items?.length === 1,
  JSON.stringify(sellerItems).slice(0, 120));

const untagged = await sellerApi(`/orgs/${org.id}/ski-swap/seller/me/items/${keeper.id}`, {
  method: 'DELETE',
});
ok('a seller may withdraw an item whose tag was never printed',
  untagged.status === 204, `HTTP ${untagged.status}`);

const tagged = await prisma.swapItem.create({
  data: {
    id: createId(), swapId: swap.id, orgId: org.id, sellerId: sellerProfile.id,
    name: 'Tagged board', sku: '77003', liveSku: '77003', priceCents: 9000,
    originalQuantity: 1, consignedAt: new Date(), hasPrintedTag: true,
  },
});
const refused = await sellerApi(`/orgs/${org.id}/ski-swap/seller/me/items/${tagged.id}`, {
  method: 'DELETE',
});
ok('a seller may not withdraw one that has a tag on it',
  refused.status === 409, `HTTP ${refused.status}`);
ok('...and is told where to go instead',
  /counter/i.test(JSON.stringify(await refused.json())));
ok('...and the item is untouched',
  (await prisma.swapItem.findUnique({ where: { id: tagged.id } }))?.deletedAt === null);

const staffRemoved = await api(`${ITEMS}/${tagged.id}`, { method: 'DELETE' });
ok('staff at the counter can remove the very same item',
  staffRemoved.status === 204, `HTTP ${staffRemoved.status}`);

await finish();

async function finish() {
  console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}
