// Issued tickets (Plan 38) against a running API and real database: staff
// issue a block and every number becomes a ticket, on sale at once; the shop
// fills each in once; a number already issued is refused saying whose; and
// returned tickets are taken back. The smoke org has no Square, so the push
// to Square is left to the first real issue.
//
//   SMOKE_BASE=https://patrolkit.io/api/v1 node apps/api/scripts/smoke-issued-tickets.mjs
//
// Sign-in endpoints are throttled to five attempts a minute, so back-to-back
// runs return 429 and look like a regression. Leave a minute between them.

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
await prisma.swapItem.deleteMany({ where: { orgId: org.id, swap: { title: 'Ticket smoke swap' } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Ticket smoke swap' } });
for (const email of ['ticket-shop@patrolkit.invalid', 'ticket-other@patrolkit.invalid']) {
  const u = await prisma.user.findFirst({ where: { email } });
  if (u) await prisma.user.delete({ where: { id: u.id } });
}

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, slug: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title: 'Ticket smoke swap', squareCategoryId: 'ticket-smoke',
    skuPrefix: 'TKS', active: true, activeSkuPrefix: 'TKS',
    // A shop's blocks work on the web only where the web takes legacy tickets (Plan 34).
    allowLegacyCheckin: true, allowLegacyWeb: true,
  },
});

/** A business seller who will be put on issued tickets. */
async function makeSeller(email, businessName) {
  const user = await prisma.user.create({
    data: { id: createId(), email, firstName: 'Shop', lastName: 'Owner' },
  });
  const membership = await prisma.membership.create({
    data: { id: createId(), userId: user.id, orgId: org.id, updatedAt: new Date() },
  });
  const seller = await prisma.sellerProfile.create({
    data: { id: createId(), membershipId: membership.id, businessName },
  });
  return { user, seller };
}

const { user: shopUser, seller: shop } = await makeSeller('ticket-shop@patrolkit.invalid', 'Alpine Sports');
const { user: otherUser, seller: other } = await makeSeller('ticket-other@patrolkit.invalid', 'Nordic Sports');

// Plan 19 derives an item's name from a category rather than taking a typed
// one, and the seller schema is strict — so a `name` in the body is a 400, not
// an ignored field. One node is enough; the tree is not what this script is
// about.
await prisma.taxonomyNode.deleteMany({ where: { orgId: org.id, label: 'Ticket smoke category' } });
const category = await prisma.taxonomyNode.create({
  data: {
    id: createId(), kind: 'CATEGORY', orgId: org.id, label: 'Ticket smoke category',
    // `<org|global>:<parent|root>:<label folded>`, the shape the service writes.
    dedupeKey: `${org.id}:root:ticket smoke category`,
    updatedAt: new Date(),
  },
});

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const staffToken = await smokeSession(prisma, BASE, staff, unwrap);
const SH = { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' };

const sellerUrl = (seller) => `${BASE}/orgs/${org.id}/ski-swap/sellers/${seller.id}/tickets`;
const issue = (seller, startNumber, endNumber) => fetch(`${sellerUrl(seller)}/issue`, {
  method: 'POST', headers: SH, body: JSON.stringify({ swapId: swap.id, startNumber, endNumber }),
});
const summary = (seller) => fetch(`${sellerUrl(seller)}?swapId=${swap.id}`, { headers: SH }).then(unwrap);

// ─── Staff issue a block ─────────────────────────────────────────────────────

const issued = await issue(shop, 67000, 67004);
const issuedBody = await unwrap(issued);
ok('a block can be issued', issued.status === 201 && issuedBody.created === 5, `HTTP ${issued.status} ${JSON.stringify(issuedBody)}`);

const tickets = await prisma.swapItem.findMany({ where: { swapId: swap.id, sellerId: shop.id }, orderBy: { sku: 'asc' } });
ok('every number is a ticket, held by the shop', tickets.map((t) => t.sku).join() === '67000,67001,67002,67003,67004',
   tickets.map((t) => t.sku).join());
ok('...unpriced, called by its number, its tag already on the goods',
   tickets.every((t) => t.priceCents === null && t.name === `Item #${t.sku}` && t.hasPrintedTag),
   JSON.stringify(tickets.map((t) => [t.name, t.priceCents, t.hasPrintedTag])));
ok('...and on sale at once, accepted by whoever issued it',
   tickets.every((t) => t.consignedAt !== null && t.consignedBy === staff.id));
ok('...with no print jobs', (await prisma.printJob.count({ where: { orgId: org.id, swapId: swap.id } })) === 0);

let sum = await summary(shop);
ok('the summary shows the run and counts', JSON.stringify(sum.runs) === JSON.stringify([{ startNumber: 67000, endNumber: 67004 }])
   && sum.issued === 5 && sum.described === 0, JSON.stringify(sum));
ok('...and that Square isn’t set up here, so none are in it yet', sum.squareReady === false && sum.notInSquare === 5,
   JSON.stringify({ squareReady: sum.squareReady, notInSquare: sum.notInSquare }));

// The Items page's push status: the swap's tickets not in Square, and whether
// a push runs. Without Square there's nothing to push, and starting one is harmless.
const pushUrl = `${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items/ticket-push`;
const push = await fetch(pushUrl, { headers: SH }).then(unwrap);
ok('The swap’s push status counts the 5 not in Square, with no Square to push to',
   push.notInSquare === 5 && push.squareReady === false && push.pushing === false, JSON.stringify(push));
const started = await fetch(pushUrl, { method: 'POST', headers: SH });
ok('Starting a push answers 202', started.status === 202, String(started.status));

const backwards = await issue(shop, 100, 50);
ok('a block that runs backwards is refused', backwards.status === 400, String(backwards.status));

// Two shops can't hold one number: it's already an item.
const overlapping = await issue(other, 67004, 67010);
const overlapBody = await overlapping.json();
ok("another shop's overlapping block is refused", overlapping.status === 400, String(overlapping.status));
ok('...listing the number and who holds it, and issuing nothing',
   overlapBody.error === '67004 (Alpine Sports) is already an item. Nothing was issued.'
   && (await prisma.swapItem.count({ where: { swapId: swap.id, sellerId: other.id } })) === 0, overlapBody.error);

// ─── A number already issued, scanned at the counter ─────────────────────────

const counter = await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`, {
  method: 'POST', headers: SH,
  body: JSON.stringify({ quantity: 1, sku: '67003', sellerId: other.id, alreadyPrinted: true, categoryId: category.id, priceCents: 1000 }),
});
const counterBody = await counter.json();
ok('creating an issued number is refused, saying whose it is',
   counter.status === 409 && counterBody.code === 'TICKET_TAKEN' && counterBody.error === 'Ticket 67003 belongs to Alpine Sports.',
   `HTTP ${counter.status} ${counterBody.code} ${counterBody.error}`);

// ─── The shop fills them in, once each ───────────────────────────────────────

const shopToken = await smokeSession(prisma, BASE, shopUser, unwrap);
const H = { authorization: `Bearer ${shopToken}`, 'content-type': 'application/json' };
const itemsUrl = `${BASE}/orgs/${org.id}/ski-swap/seller/me/items`;
const stateUrl = `${BASE}/orgs/${org.id}/ski-swap/seller/me/ticket-state?swapId=${swap.id}`;
const add = (body) => fetch(itemsUrl, { method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, quantity: 1, ...body }) });

let state = await fetch(stateUrl, { headers: H }).then(unwrap);
ok('the form opens on the lowest untouched ticket', state.suggested === 67000 && state.exhausted === false, JSON.stringify(state));

const first = await add({ categoryId: category.id, priceCents: 25000 }).then(unwrap);
ok('an add with no number describes that ticket', first.sku === '67000' && first.priceCents === 25000, JSON.stringify({ sku: first.sku, price: first.priceCents }));
ok('...the same item, not a new one', first.id === tickets[0].id && (await prisma.swapItem.count({ where: { swapId: swap.id } })) === 5);

const chosen = await add({ categoryId: category.id, priceCents: 6500, sku: '67002' }).then(unwrap);
ok('a typed number describes that one instead', chosen.sku === '67002', chosen.sku);

state = await fetch(stateUrl, { headers: H }).then(unwrap);
ok('the suggestion is the lowest still untouched', state.suggested === 67001, String(state.suggested));

const again = await fetch(`${itemsUrl}/${first.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ priceCents: 30000 }) });
const againBody = await again.json();
ok('a described ticket is refused to the shop, sending it to staff',
   again.status === 409 && againBody.code === 'TICKET_DESCRIBED', `HTTP ${again.status} ${againBody.code} ${againBody.error}`);
const twice = await add({ categoryId: category.id, priceCents: 1000, sku: '67000' });
ok('...however it asks', twice.status === 409, String(twice.status));

const outside = await add({ categoryId: category.id, priceCents: 1000, sku: '99999' });
const outsideBody = await outside.json();
ok('a number it doesn’t hold is refused, naming the ones it does',
   outside.status === 400 && /67000–67004/.test(outsideBody.error ?? ''), outsideBody.error);
const notDigits = await add({ categoryId: category.id, priceCents: 1000, sku: 'ABC12' });
ok('a number that is not digits is refused', notDigits.status === 400, String(notDigits.status));

const staffFix = await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items/${first.id}`, {
  method: 'PATCH', headers: SH, body: JSON.stringify({ priceCents: 30000 }),
});
ok('staff can still change it', staffFix.ok && (await unwrap(staffFix)).priceCents === 30000, `HTTP ${staffFix.status}`);

await add({ categoryId: category.id, priceCents: 2000, sku: '67001' });
await add({ categoryId: category.id, priceCents: 2000, sku: '67003' });
await add({ priceCents: 2000, sku: '67004' });
state = await fetch(stateUrl, { headers: H }).then(unwrap);
ok('with every ticket described, the shop is out', state.suggested === null && state.exhausted === true, JSON.stringify(state));
const noneLeft = await add({ categoryId: category.id, priceCents: 1000 });
ok('...and an add is refused', noneLeft.status === 409, String(noneLeft.status));

sum = await summary(shop);
ok('the summary counts them described', sum.described === 5, String(sum.described));

// ─── Printers alongside (Plan 31) ────────────────────────────────────────────

const printer = await prisma.swapPrinter.create({
  data: { orgId: org.id, name: 'Ticket smoke printer', bluetoothName: 'M110-TKS' },
});
const assign = await fetch(`${BASE}/orgs/${org.id}/ski-swap/printers/${printer.id}`, {
  method: 'PATCH', headers: SH, body: JSON.stringify({ assignedSellerId: other.id }),
});
ok('a printer can be given to a seller', assign.status === 200, String(assign.status));
const forPrinterSeller = await issue(other, 75000, 75010);
ok('...and tickets issued to a seller with a printer', forPrinterSeller.status === 201, String(forPrinterSeller.status));

// ─── A file of tickets ───────────────────────────────────────────────────────

await issue(shop, 70000, 70009);
const importUrl = `${BASE}/orgs/${org.id}/ski-swap/seller/me/items/import`;
const upload = async (csv) => {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'items.csv');
  form.append('swapId', swap.id);
  const res = await fetch(importUrl, { method: 'POST', headers: { authorization: `Bearer ${shopToken}` }, body: form });
  return { status: res.status, body: await res.json() };
};

// One bad row stops the whole file.
const partly = await upload('sku,name,price\n70000,Good skis,250.00\n99999,Not ours,180.00\n');
ok('a file with one bad row reports it', (partly.body.data ?? []).some((r) => r.outcome === 'error'),
   JSON.stringify((partly.body.data ?? []).map((r) => r.outcome)));
ok('...and writes none of the good rows either',
   (await prisma.swapItem.findFirst({ where: { swapId: swap.id, sku: '70000' } }))?.name === 'Item #70000');

const dupes = await upload('sku,name,price\n70001,One,10.00\n70001,Two,20.00\n');
ok('a number repeated inside the file is refused', (dupes.body.data ?? []).some((r) => /also on line/.test(r.error ?? '')));

const good = await upload('sku,name,price\n70005,Boots,180.00\n70002,,90.00\n70009,Poles,\n');
const goodRows = good.body.data ?? [];
ok('a good file fills in its tickets', goodRows.length === 3 && goodRows.every((r) => r.outcome === 'updated'),
   JSON.stringify(goodRows.map((r) => r.outcome)));
const filled = await prisma.swapItem.findMany({ where: { swapId: swap.id, sku: { in: ['70002', '70005', '70009'] } }, orderBy: { sku: 'asc' } });
ok('...names and prices landing, a blank one left alone',
   JSON.stringify(filled.map((i) => [i.sku, i.name, i.priceCents])) === JSON.stringify([['70002', 'Item #70002', 9000], ['70005', 'Boots', 18000], ['70009', 'Poles', null]]),
   JSON.stringify(filled.map((i) => [i.sku, i.name, i.priceCents])));

const redo = await upload('sku,name,price\n70005,Other boots,150.00\n');
ok('a shop’s file can’t describe a ticket twice',
   (redo.body.data ?? [])[0]?.error === '70005 is already described. Ask the swap’s staff to change it.',
   (redo.body.data ?? [])[0]?.error);

// ─── Returned tickets ────────────────────────────────────────────────────────

const removed = await fetch(`${sellerUrl(shop)}/remove`, {
  method: 'POST', headers: SH, body: JSON.stringify({ swapId: swap.id, startNumber: 70000, endNumber: 70009 }),
}).then(unwrap);
ok('removing a span takes back the untouched ones and keeps the rest, saying why',
   removed.removed === 7 && JSON.stringify(removed.kept) === JSON.stringify([
     { sku: '70002', why: 'priced' }, { sku: '70005', why: 'priced' }, { sku: '70009', why: 'described' },
   ]), JSON.stringify(removed));
ok('...the removed ones withdrawn, and their numbers free again',
   (await prisma.swapItem.count({ where: { swapId: swap.id, sku: '70000', deletedAt: { not: null }, liveSku: null } })) === 1);
const reissue = await issue(other, 70000, 70001);
ok('...so they can be issued again', reissue.status === 201, String(reissue.status));

// ─── A seller with no tickets can't name one ─────────────────────────────────

const plain = await fetch(itemsUrl, {
  method: 'POST',
  headers: { authorization: `Bearer ${await smokeSession(prisma, BASE, otherUser, unwrap)}`, 'content-type': 'application/json' },
  body: JSON.stringify({ swapId: swap.id, categoryId: category.id, priceCents: 1000, quantity: 1, sku: '12345' }),
});
ok('a ticket it doesn’t hold is refused', plain.status === 400, String(plain.status));

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.swapSkuCounter.deleteMany({ where: { swapId: swap.id } });
await prisma.swapPrinter.delete({ where: { id: printer.id } });
await prisma.taxonomyNode.delete({ where: { id: category.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
for (const email of ['ticket-shop@patrolkit.invalid', 'ticket-other@patrolkit.invalid']) {
  const u = await prisma.user.findFirst({ where: { email } });
  if (u) await prisma.user.delete({ where: { id: u.id } });
}
await prisma.$disconnect();
console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
