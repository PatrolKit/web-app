// Walks acceptance against a running API and real database: a self check-in
// with the toggle off, then on, a staff scan, and the toggle flipping mid-swap.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-consignment.mjs
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
await prisma.printJob.deleteMany({ where: { orgId: org.id } });
await prisma.swapItem.deleteMany({ where: { orgId: org.id, swap: { title: 'Consign smoke swap' } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Consign smoke swap' } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'Consign station' } });
const priorSeller = await prisma.user.findFirst({ where: { email: 'consign-seller@patrolkit.invalid' } });
if (priorSeller) await prisma.user.delete({ where: { id: priorSeller.id } });

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, title: 'Consign smoke swap', squareCategoryId: 'consign-smoke',
    skuPrefix: 'CNS', active: true, activeSkuPrefix: 'CNS',
  },
});
const station = await prisma.checkinStation.create({
  data: { id: createId(), orgId: org.id, name: 'Consign station', code: 'K', updatedAt: new Date() },
});

// Address and payout are finish's own preconditions — without them it refuses
// before it ever gets to consignment, and every assertion below it reads as a
// consignment bug.
const user = await prisma.user.create({
  data: {
    id: createId(), email: 'consign-seller@patrolkit.invalid',
    firstName: 'Dana', lastName: 'Reyes',
    street: '1 Summit Rd', city: 'Stowe', state: 'VT', zip: '05672',
    payoutMethod: 'CHECK',
  },
});
const membership = await prisma.membership.create({
  data: { id: createId(), userId: user.id, orgId: org.id, updatedAt: new Date() },
});
// A shop: only a shop may add items away from a station.
const seller = await prisma.sellerProfile.create({
  data: { id: createId(), membershipId: membership.id, businessName: 'Consign Smoke Sports' },
});

// Plan 19 derives an item's name from a category rather than taking a typed
// one, and a seller who is not on tickets has to pick one. The tree itself is
// not what these assertions are about, so one node is enough.
await prisma.taxonomyNode.deleteMany({ where: { orgId: org.id, label: 'Consign smoke category' } });
const category = await prisma.taxonomyNode.create({
  data: {
    id: createId(), kind: 'CATEGORY', orgId: org.id, label: 'Consign smoke category',
    // `<org|global>:<parent|root>:<label folded>`, the shape the service writes.
    dedupeKey: `${org.id}:root:consign smoke category`,
    updatedAt: new Date(),
  },
});

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const staffToken = await smokeSession(prisma, BASE, staff, unwrap);
const SH = { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' };

const sellerToken = await smokeSession(prisma, BASE, user, unwrap);
const H = { authorization: `Bearer ${sellerToken}`, 'content-type': 'application/json' };

const settingsUrl = `${BASE}/orgs/${org.id}/ski-swap/settings`;
const itemsUrl = `${BASE}/orgs/${org.id}/ski-swap/seller/me/items`;
const swapItemsUrl = `${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`;

const setToggle = (on) =>
  fetch(settingsUrl, { method: 'PATCH', headers: SH, body: JSON.stringify({ requireConsignmentScan: on }) });

const addItem = (_label, stationId) =>
  fetch(itemsUrl, {
    method: 'POST', headers: H,
    // No `name`: Plan 19 derives it from the category tree, and the schema is
    // strict, so sending one is a 400. These assertions are about consignment,
    // so the item takes its fallback name and nothing here changes meaning.
    body: JSON.stringify({
      swapId: swap.id, categoryId: category.id, priceCents: 5000, quantity: 1,
      ...(stationId ? { stationId } : {}),
    }),
  }).then(unwrap);

// ─── The default: nothing waits ──────────────────────────────────────────────

const settings = await fetch(settingsUrl, { headers: SH }).then(unwrap);
ok('the scan is off by default', settings.requireConsignmentScan === false,
   String(settings.requireConsignmentScan));

const early = await addItem('Toggle-off skis', station.id);
ok('an item checked in with the toggle off is consigned at once',
   early.consignedAt !== null, String(early.consignedAt));

// ─── Turning it on does not disturb what is already down ─────────────────────

const turnedOn = await setToggle(true);
ok('the toggle can be turned on', turnedOn.status === 200, String(turnedOn.status));

const stillDown = await prisma.swapItem.findUnique({ where: { id: early.id } });
ok('and an item already on the floor stays consigned',
   stillDown.consignedAt !== null, String(stillDown.consignedAt));

// ─── With it on, a self check-in waits ───────────────────────────────────────

const waiting = await addItem('Waiting boots', station.id);
ok('an item checked in after the switch waits', waiting.consignedAt === null,
   String(waiting.consignedAt));

const second = await addItem('Waiting poles', station.id);

// A business seller at their own desk sends no station, and never waits.
const atDesk = await addItem('Desk item', null);
ok('an item entered away from a station does not wait',
   atDesk.consignedAt !== null, String(atDesk.consignedAt));

// Staff entering an item is already a person handling it.
const byStaff = await fetch(swapItemsUrl, {
  method: 'POST', headers: SH,
  body: JSON.stringify({
    categoryId: category.id, priceCents: 1000, quantity: 1, sellerId: seller.id,
  }),
}).then(unwrap);
// `!== null` alone passes on `undefined`, which is what a failed create returns
// — so this checks the field is actually a date.
ok('an item a staff member entered does not wait',
   typeof byStaff.consignedAt === 'string', JSON.stringify(byStaff));

// ─── Finishing does not put a waiting item on sale ───────────────────────────

const finish = await fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/finish`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ swapId: swap.id, stationId: station.id }),
}).then(unwrap);
ok('finishing reports how many are waiting', finish.awaitingConsignment === 2,
   JSON.stringify(finish));
ok('and still prints a receipt', finish.receiptPages >= 2, String(finish.receiptPages));

const afterFinish = await prisma.swapItem.findUnique({ where: { id: waiting.id } });
ok('a waiting item is still not consigned after finish',
   afterFinish.consignedAt === null, String(afterFinish.consignedAt));

// ─── Staff accept one ────────────────────────────────────────────────────────

const found = await fetch(`${swapItemsUrl}/by-sku/${waiting.sku}`, { headers: SH }).then(unwrap);
ok('an item can be found by the number on its tag', found.id === waiting.id, found.sku);

const wrongSku = await fetch(`${swapItemsUrl}/by-sku/NOSUCHTAG`, { headers: SH });
ok('an unknown tag is refused', wrongSku.status === 404, String(wrongSku.status));

// The fuzzy search would match a longer SKU; the scanner lookup must not.
const prefix = waiting.sku.slice(0, waiting.sku.length - 1);
const partial = await fetch(`${swapItemsUrl}/by-sku/${prefix}`, { headers: SH });
ok('a partial tag is not treated as a match', partial.status === 404, String(partial.status));

const consigned = await fetch(`${swapItemsUrl}/${waiting.id}/consign`, { method: 'POST', headers: SH }).then(unwrap);
ok('accepting an item consigns it', consigned.consignedAt !== null, String(consigned.consignedAt));

const stamped = await prisma.swapItem.findUnique({ where: { id: waiting.id } });
ok('and records who accepted it', stamped.consignedBy !== null, String(stamped.consignedBy));

// A scanner double-reads constantly; the second read must not be an error.
const again = await fetch(`${swapItemsUrl}/${waiting.id}/consign`, { method: 'POST', headers: SH });
ok('accepting the same item twice is not an error', again.status === 200, String(again.status));
const unchanged = await prisma.swapItem.findUnique({ where: { id: waiting.id } });
ok('and does not move the time it was accepted',
   unchanged.consignedAt.getTime() === stamped.consignedAt.getTime(),
   `${unchanged.consignedAt.toISOString()} vs ${stamped.consignedAt.toISOString()}`);

// ─── The list staff work from ────────────────────────────────────────────────

const stillWaiting = await fetch(`${swapItemsUrl}?consigned=false&sellerId=${seller.id}`, { headers: SH }).then(unwrap);
ok('the waiting list holds only what has not been accepted',
   stillWaiting.items.length === 1 && stillWaiting.items[0].id === second.id,
   JSON.stringify(stillWaiting.items.map((i) => i.sku)));

const accepted = await fetch(`${swapItemsUrl}?consigned=true&sellerId=${seller.id}`, { headers: SH }).then(unwrap);
// The one just accepted, plus the three that never waited.
ok('and the accepted list holds the rest',
   accepted.items.every((i) => i.consignedAt !== null) && accepted.items.length === 4,
   String(accepted.items.length));

// ─── A refused item is simply left ───────────────────────────────────────────

const refused = await prisma.swapItem.findUnique({ where: { id: second.id } });
ok('an item nobody scanned stays unconsigned and unsold',
   refused.consignedAt === null && refused.squareItemId === null,
   `${refused.consignedAt} / ${refused.squareItemId}`);

// ─── Turning it back off ─────────────────────────────────────────────────────

await setToggle(false);
const afterOff = await prisma.swapItem.findUnique({ where: { id: second.id } });
ok('turning the toggle off does not accept what was already waiting',
   afterOff.consignedAt === null, String(afterOff.consignedAt));

const laterItem = await addItem('After the toggle went off', station.id);
ok('but a new item no longer waits', laterItem.consignedAt !== null, String(laterItem.consignedAt));

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.skiSwapSettings.updateMany({ where: { orgId: org.id }, data: { requireConsignmentScan: false } });
await prisma.printJob.deleteMany({ where: { stationId: station.id } });
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.swapSkuCounter.deleteMany({ where: { swapId: swap.id } });
await prisma.taxonomyNode.delete({ where: { id: category.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.checkinStation.delete({ where: { id: station.id } });
await prisma.user.delete({ where: { id: user.id } });
await prisma.$disconnect();
