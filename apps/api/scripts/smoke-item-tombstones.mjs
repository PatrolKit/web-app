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
//   - a seller can withdraw an item nobody has accepted, and cannot once staff
//     have — which on every path is the same moment it becomes sellable;
//   - who uploaded a file decides whether its rows arrive accepted;
//   - one press accepts everything a shop was waiting on, and pressing it twice
//     accepts nothing.
//
// Sign-in is throttled to five a minute and this script signs in twice — once
// as staff, once as the seller, because the guard on withdrawing an accepted
// item is only observable from the seller's own session. Two runs inside a minute
// will therefore hit the limit; leave a minute between them.
//
// Everything below is about what happens to an item after it is deleted, so the
// first thing asserted is that the item existed and was found before the delete.
// A delete of nothing tombstones nothing and every later check would pass.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import argon2 from 'argon2';

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
await prisma.device.deleteMany({
  where: { orgId: org.id, name: { in: ['Tombstone smoke iPad', 'Tombstone smoke bridge'] } },
});
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

// The case the guard actually exists for: a station self check-in at an org
// that requires a scan. The seller has tagged their gear and is standing beside
// it, and may take a row back out right up until a staff member accepts it.
await prisma.skiSwapSettings.upsert({
  where: { orgId: org.id },
  update: { requireConsignmentScan: true },
  create: { orgId: org.id, requireConsignmentScan: true },
});

const waiting = await prisma.swapItem.create({
  data: {
    id: createId(), swapId: swap.id, orgId: org.id, sellerId: sellerProfile.id,
    name: 'Waiting helmet', sku: '77004', liveSku: '77004', priceCents: 3500,
    originalQuantity: 1,
    // Null: tagged by the seller, not yet accepted by anybody.
    consignedAt: null,
    // Tagged already, which is what the old guard tested and why it was wrong:
    // the tag prints during check-in, long before staff look at the gear.
    hasPrintedTag: true,
  },
});

const withdrawn = await sellerApi(`/orgs/${org.id}/ski-swap/seller/me/items/${waiting.id}`, {
  method: 'DELETE',
});
ok('a seller may withdraw an item that is tagged but not yet accepted',
  withdrawn.status === 204, `HTTP ${withdrawn.status}`);
ok('...which is the whole point: the tag prints before the scan',
  (await prisma.swapItem.findUnique({ where: { id: waiting.id } }))?.deletedAt !== null);

await prisma.skiSwapSettings.update({
  where: { orgId: org.id },
  data: { requireConsignmentScan: false },
});

// And once accepted, it is staff work.
const accepted = await prisma.swapItem.create({
  data: {
    id: createId(), swapId: swap.id, orgId: org.id, sellerId: sellerProfile.id,
    name: 'Accepted board', sku: '77003', liveSku: '77003', priceCents: 9000,
    originalQuantity: 1, consignedAt: new Date(), hasPrintedTag: false,
  },
});
const refused = await sellerApi(`/orgs/${org.id}/ski-swap/seller/me/items/${accepted.id}`, {
  method: 'DELETE',
});
ok('a seller may not withdraw one that has been accepted for sale',
  refused.status === 409, `HTTP ${refused.status}`);
ok('...even with no tag printed, because it is live at the register',
  !accepted.hasPrintedTag);
ok('...and is told where to go instead',
  /counter/i.test(JSON.stringify(await refused.json())));
ok('...and the item is untouched',
  (await prisma.swapItem.findUnique({ where: { id: accepted.id } }))?.deletedAt === null);

const staffRemoved = await api(`${ITEMS}/${accepted.id}`, { method: 'DELETE' });
ok('staff at the counter can remove the very same item',
  staffRemoved.status === 204, `HTTP ${staffRemoved.status}`);

console.log('\n── A file staff uploaded for a shop ─────────────────────');

// Who uploaded the file decides whether its rows arrive received.
//
// Staff uploading for a shop means the boxes are in the room and a volunteer is
// loading the list that came with them. A shop uploading its own file means a
// list of what it intends to bring, and nobody has seen any of it.
await prisma.legacyTicketRange.create({
  data: {
    id: createId(), orgId: org.id, swapId: swap.id, sellerId: sellerProfile.id,
    startNumber: 78000, endNumber: 78100,
  },
});

const csv = (rows) => 'sku,name,price\n' + rows.map((r) => `${r},Imported ${r},50.00`).join('\n') + '\n';
const upload = async (url, tokenToUse, rows, extra = {}) => {
  const form = new FormData();
  form.append('file', new Blob([csv(rows)], { type: 'text/csv' }), 'inventory.csv');
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenToUse}` },
    body: form,
  }).then(unwrap);
};

const staffUpload = await upload(`${ITEMS}/import`, token, ['78001', '78002'], {
  sellerId: sellerProfile.id,
});
ok('staff can upload a file for a shop',
  Array.isArray(staffUpload) && staffUpload.every((r) => r.outcome === 'created'),
  JSON.stringify(staffUpload).slice(0, 160));

const staffRows = await prisma.swapItem.findMany({
  where: { swapId: swap.id, sku: { in: ['78001', '78002'] } },
});
ok('...and every row staff uploaded is received on the way in',
  staffRows.length === 2 && staffRows.every((r) => r.consignedAt !== null),
  `${staffRows.length} rows, ${staffRows.filter((r) => r.consignedAt).length} received`);
ok('so the shop cannot delete a row from it',
  (await sellerApi(`/orgs/${org.id}/ski-swap/seller/me/items/${staffRows[0]?.id}`,
    { method: 'DELETE' })).status === 409);

const shopUpload = await upload(
  `/orgs/${org.id}/ski-swap/seller/me/items/import`, sellerToken, ['78010', '78011', '78012'],
  { swapId: swap.id },
);
ok('a shop can upload its own file',
  Array.isArray(shopUpload) && shopUpload.every((r) => r.outcome === 'created'),
  JSON.stringify(shopUpload).slice(0, 160));

const shopRows = await prisma.swapItem.findMany({
  where: { swapId: swap.id, sku: { in: ['78010', '78011', '78012'] } },
});
ok('...and none of it is received, because nobody has seen it',
  shopRows.length === 3 && shopRows.every((r) => r.consignedAt === null),
  `${shopRows.length} rows, ${shopRows.filter((r) => r.consignedAt).length} received`);
ok('...nor in Square, which is the same fact said twice',
  shopRows.every((r) => r.squareVariationId === null));
ok('so the shop can still take one back off its own list',
  (await sellerApi(`/orgs/${org.id}/ski-swap/seller/me/items/${shopRows[0]?.id}`,
    { method: 'DELETE' })).status === 204);

console.log('\n── Staff accepting a delivery ─────────────────────────');

const waitingBefore = await prisma.swapItem.count({
  where: { swapId: swap.id, sellerId: sellerProfile.id, consignedAt: null, deletedAt: null },
});
ok('the shop has items waiting to be accepted', waitingBefore > 0, `${waitingBefore} waiting`);

const batch = await api(`${ITEMS}/consign`, {
  method: 'POST', body: JSON.stringify({ sellerId: sellerProfile.id }),
}).then(unwrap);
ok('one press accepts everything they were waiting on',
  batch.consigned === waitingBefore, `accepted ${batch.consigned} of ${waitingBefore}`);

const waitingAfter = await prisma.swapItem.count({
  where: { swapId: swap.id, sellerId: sellerProfile.id, consignedAt: null, deletedAt: null },
});
ok('...leaving none behind', waitingAfter === 0, `${waitingAfter} still waiting`);

const stamped = await prisma.swapItem.findMany({
  where: { swapId: swap.id, sellerId: sellerProfile.id, deletedAt: null },
  select: { consignedBy: true, consignedAt: true },
});
ok('...and recording who accepted them',
  stamped.every((r) => r.consignedAt !== null) &&
  stamped.some((r) => r.consignedBy === staff.id),
  JSON.stringify(stamped.map((r) => r.consignedBy)).slice(0, 120));

// Idempotent: two volunteers pressing it must not restamp what the first
// accepted, which would move the time it happened.
const firstTimes = stamped.map((r) => r.consignedAt?.toISOString()).sort();
const again = await api(`${ITEMS}/consign`, {
  method: 'POST', body: JSON.stringify({ sellerId: sellerProfile.id }),
}).then(unwrap);
ok('pressing it twice accepts nothing the second time', again.consigned === 0,
  `accepted ${again.consigned}`);

const afterSecond = await prisma.swapItem.findMany({
  where: { swapId: swap.id, sellerId: sellerProfile.id, deletedAt: null },
  select: { consignedAt: true },
});
ok('...and does not move when they were accepted',
  JSON.stringify(afterSecond.map((r) => r.consignedAt?.toISOString()).sort()) ===
    JSON.stringify(firstTimes));

ok('a shop cannot delete what has now been accepted',
  (await sellerApi(`/orgs/${org.id}/ski-swap/seller/me/items/${shopRows[1]?.id}`,
    { method: 'DELETE' })).status === 409);

console.log('\n── The staff iPad reaching the same button ──────────────');

// `ItemController` carries `@RequireDeviceRole('ski_swap.staff_check_in')` on
// the class, so every route on it — batch consign included — is already open
// to a check-in iPad. That is inherited rather than written on the method, and
// a reader of `consignAll` alone would conclude the opposite, so it is asserted
// here rather than left to be discovered by whoever builds the iPad screen.
const ipadSecret = createId();
const ipadClientId = createId();
await prisma.device.create({
  data: {
    id: createId(), orgId: org.id, name: 'Tombstone smoke iPad',
    role: 'ski_swap.staff_check_in', clientId: ipadClientId,
    secretHash: await argon2.hash(ipadSecret, { type: argon2.argon2id }),
  },
});
const ipadToken = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: ipadClientId, clientSecret: ipadSecret }),
}).then(unwrap);

const ipadWaiting = await prisma.swapItem.create({
  data: {
    id: createId(), swapId: swap.id, orgId: org.id, sellerId: sellerProfile.id,
    name: 'For the iPad to accept', sku: '78500', liveSku: '78500',
    priceCents: 4000, originalQuantity: 1, consignedAt: null,
  },
});

const fromIpad = await fetch(`${BASE}${ITEMS}/consign`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ipadToken.accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ sellerId: sellerProfile.id }),
});
ok('a check-in iPad can accept a seller\'s items', fromIpad.status === 200,
  `HTTP ${fromIpad.status}`);

const acceptedByIpad = await prisma.swapItem.findUnique({ where: { id: ipadWaiting.id } });
ok('...and is recorded as the one that did it',
  acceptedByIpad?.consignedAt !== null && acceptedByIpad?.consignedBy !== null &&
  acceptedByIpad?.consignedBy !== staff.id,
  `consignedBy ${acceptedByIpad?.consignedBy}`);

// A device of the wrong role is still refused, so the role is doing work.
const bridgeSecret = createId();
const bridgeClientId = createId();
await prisma.device.create({
  data: {
    id: createId(), orgId: org.id, name: 'Tombstone smoke bridge',
    role: 'ski_swap.print_bridge', clientId: bridgeClientId,
    secretHash: await argon2.hash(bridgeSecret, { type: argon2.argon2id }),
  },
});
const bridgeToken = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: bridgeClientId, clientSecret: bridgeSecret }),
}).then(unwrap);

const fromBridge = await fetch(`${BASE}${ITEMS}/consign`, {
  method: 'POST',
  headers: { authorization: `Bearer ${bridgeToken.accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ sellerId: sellerProfile.id }),
});
ok('a print bridge is refused, so the role is doing work',
  fromBridge.status === 403, `HTTP ${fromBridge.status}`);

await finish();

async function finish() {
  console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}
