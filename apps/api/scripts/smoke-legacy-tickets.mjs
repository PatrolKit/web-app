// Walks legacy ticket ranges against a running API and real database: staff
// issue a block, the seller spends it in order, skips one, finds it again, and
// is refused everything they should be.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-legacy-tickets.mjs
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
await prisma.swapItem.deleteMany({ where: { orgId: org.id, swap: { title: 'Ticket smoke swap' } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Ticket smoke swap' } });
for (const email of ['ticket-shop@patrolkit.invalid', 'ticket-other@patrolkit.invalid']) {
  const u = await prisma.user.findFirst({ where: { email } });
  if (u) await prisma.user.delete({ where: { id: u.id } });
}

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, title: 'Ticket smoke swap', squareCategoryId: 'ticket-smoke',
    skuPrefix: 'TKS', active: true, activeSkuPrefix: 'TKS',
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
const { seller: other } = await makeSeller('ticket-other@patrolkit.invalid', 'Nordic Sports');

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

const rangesUrl = `${BASE}/orgs/${org.id}/ski-swap/sellers/${shop.id}/ticket-ranges`;

// ─── Staff issue a block ─────────────────────────────────────────────────────

const issued = await fetch(rangesUrl, {
  method: 'POST', headers: SH,
  body: JSON.stringify({ swapId: swap.id, startNumber: 67000, endNumber: 67004 }),
}).then(unwrap);
ok('a block can be issued', Array.isArray(issued) && issued.length === 1, JSON.stringify(issued).slice(0, 90));
ok('and reports how many tickets it holds', issued[0]?.ticketCount === 5, String(issued[0]?.ticketCount));
ok('with none of them used yet', issued[0]?.usedCount === 0, String(issued[0]?.usedCount));

const backwards = await fetch(rangesUrl, {
  method: 'POST', headers: SH,
  body: JSON.stringify({ swapId: swap.id, startNumber: 100, endNumber: 50 }),
});
ok('a range that runs backwards is refused', backwards.status === 400, String(backwards.status));

// Overlap is checked across sellers: two shops cannot hold one number.
const overlapping = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers/${other.id}/ticket-ranges`,
  { method: 'POST', headers: SH, body: JSON.stringify({ swapId: swap.id, startNumber: 67004, endNumber: 67100 }) },
);
ok("another shop's overlapping block is refused", overlapping.status === 409, String(overlapping.status));
const overlapBody = await overlapping.json();
ok('and the refusal names who already holds it',
   /Alpine Sports/.test(overlapBody.error ?? ''), overlapBody.error);

// ─── The seller spends them ──────────────────────────────────────────────────

const shopToken = await smokeSession(prisma, BASE, shopUser, unwrap);
const H = { authorization: `Bearer ${shopToken}`, 'content-type': 'application/json' };
const itemsUrl = `${BASE}/orgs/${org.id}/ski-swap/seller/me/items`;
const stateUrl = `${BASE}/orgs/${org.id}/ski-swap/seller/me/ticket-state?swapId=${swap.id}`;

let state = await fetch(stateUrl, { headers: H }).then(unwrap);
ok('the form opens on the first ticket', state.suggested === 67000, String(state.suggested));
ok('and does not think the seller is out', state.exhausted === false, String(state.exhausted));

const first = await fetch(itemsUrl, {
  method: 'POST', headers: H,
  body: JSON.stringify({ swapId: swap.id, categoryId: category.id, priceCents: 25000, quantity: 1 }),
}).then(unwrap);
ok('an item with no number takes the suggestion', first.sku === '67000', first.sku ?? JSON.stringify(first));

state = await fetch(stateUrl, { headers: H }).then(unwrap);
ok('the suggestion advances', state.suggested === 67001, String(state.suggested));

// Skip 67001 — binned — and use 67002 instead.
const skipped = await fetch(itemsUrl, {
  method: 'POST', headers: H,
  body: JSON.stringify({ swapId: swap.id, categoryId: category.id, priceCents: 6500, quantity: 1, sku: '67002' }),
}).then(unwrap);
ok('a typed number out of order is accepted', skipped.sku === '67002', skipped.sku);

state = await fetch(stateUrl, { headers: H }).then(unwrap);
ok('and the suggestion carries on past the gap rather than offering it back',
   state.suggested === 67003, String(state.suggested));

// No category either, which is the point: a seller on tickets may list
// something the tree says nothing about, and the name falls back (D12).
const unnamed = await fetch(itemsUrl, {
  method: 'POST', headers: H,
  body: JSON.stringify({ swapId: swap.id, priceCents: 4000, quantity: 1, sku: '67003' }),
}).then(unwrap);
// Called by its number since Plan 20 (36bd10d), like any uncategorised item.
ok('a blank name is called by its number',
   unnamed.name === 'Item #67003', unnamed.name);

// Legacy items carry their tag already.
const stored = await prisma.swapItem.findFirst({ where: { swapId: swap.id, sku: '67000' } });
ok('a legacy item counts as printed', stored.hasPrintedTag === true, String(stored.hasPrintedTag));
const jobs = await prisma.printJob.count({ where: { orgId: org.id, swapId: swap.id } });
ok('and queued no tag', jobs === 0, `${jobs} jobs`);

// ─── What the seller may not do ──────────────────────────────────────────────

const twice = await fetch(itemsUrl, {
  method: 'POST', headers: H,
  body: JSON.stringify({ swapId: swap.id, categoryId: category.id, priceCents: 1000, quantity: 1, sku: '67000' }),
});
ok('a number already on an item is refused', twice.status === 409, String(twice.status));

const outside = await fetch(itemsUrl, {
  method: 'POST', headers: H,
  body: JSON.stringify({ swapId: swap.id, categoryId: category.id, priceCents: 1000, quantity: 1, sku: '99999' }),
});
// This and the next assert a 400, which a body the schema rejects also returns
// — so until these stopped sending a `name` Plan 19 had removed, they passed
// without ever reaching the rule they name.
ok('a number outside their block is refused', outside.status === 400, String(outside.status));

const notDigits = await fetch(itemsUrl, {
  method: 'POST', headers: H,
  body: JSON.stringify({ swapId: swap.id, categoryId: category.id, priceCents: 1000, quantity: 1, sku: 'ABC12' }),
});
ok('a number that is not digits is refused', notDigits.status === 400, String(notDigits.status));

// ─── The end of the pad, and the ticket that turns up ────────────────────────

await fetch(itemsUrl, {
  method: 'POST', headers: H,
  body: JSON.stringify({ swapId: swap.id, categoryId: category.id, priceCents: 2000, quantity: 1, sku: '67004' }),
});

state = await fetch(stateUrl, { headers: H }).then(unwrap);
// 67001 was binned and is still unused, so there is nothing to suggest but the
// seller is not out.
ok('past the top of the block there is nothing to suggest', state.suggested === null, String(state.suggested));
ok('but the seller is not out while a skipped ticket is unused',
   state.exhausted === false, String(state.exhausted));

const found = await fetch(itemsUrl, {
  method: 'POST', headers: H,
  body: JSON.stringify({ swapId: swap.id, categoryId: category.id, priceCents: 3000, quantity: 1, sku: '67001' }),
}).then(unwrap);
ok('a skipped ticket found later is still accepted', found.sku === '67001', found.sku);

state = await fetch(stateUrl, { headers: H }).then(unwrap);
ok('and only now is the seller out', state.exhausted === true, String(state.exhausted));

const noneLeft = await fetch(itemsUrl, {
  method: 'POST', headers: H,
  body: JSON.stringify({ swapId: swap.id, categoryId: category.id, priceCents: 1000, quantity: 1 }),
});
ok('an item with nothing left is refused', noneLeft.status === 409, String(noneLeft.status));

// ─── Exclusivity with printers (D1) ──────────────────────────────────────────

const printer = await prisma.swapPrinter.create({
  data: { orgId: org.id, name: 'Ticket smoke printer', bluetoothName: 'M110-TKS' },
});
const assign = await fetch(`${BASE}/orgs/${org.id}/ski-swap/printers/${printer.id}`, {
  method: 'PATCH', headers: SH, body: JSON.stringify({ assignedSellerId: shop.id }),
});
// Both at once since Plan 31: each item is one or the other.
ok('a printer can be given to a seller on tickets', assign.status === 200, String(assign.status));

await prisma.swapPrinter.update({ where: { id: printer.id }, data: { assignedSellerId: other.id } });
const rangeForPrinterSeller = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers/${other.id}/ticket-ranges`,
  // Clear of the blocks issued below, now that this succeeds.
  { method: 'POST', headers: SH, body: JSON.stringify({ swapId: swap.id, startNumber: 75000, endNumber: 75010 }) },
);
ok('and tickets can be issued to a seller with a printer',
   rangeForPrinterSeller.status === 201, String(rangeForPrinterSeller.status));

// ─── Taking a block back ─────────────────────────────────────────────────────

const listed = await fetch(`${rangesUrl}?swapId=${swap.id}`, { headers: SH }).then(unwrap);
ok('the block reports every ticket as used', listed[0]?.usedCount === 5, String(listed[0]?.usedCount));

const inUse = await fetch(`${rangesUrl}/${listed[0].id}`, { method: 'DELETE', headers: SH });
ok('a block whose tickets are on items cannot be removed', inUse.status === 409, String(inUse.status));

await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
const removed = await fetch(`${rangesUrl}/${listed[0].id}`, { method: 'DELETE', headers: SH });
ok('and can be removed once they are not', removed.status === 200, String(removed.status));

// ─── A whole inventory at once ───────────────────────────────────────────────

// The block was taken back above, so issue a fresh one to import into.
await fetch(rangesUrl, {
  method: 'POST', headers: SH,
  body: JSON.stringify({ swapId: swap.id, startNumber: 70000, endNumber: 70009 }),
});

const importUrl = `${BASE}/orgs/${org.id}/ski-swap/seller/me/items/import`;
const upload = async (csv) => {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'items.csv');
  form.append('swapId', swap.id);
  const res = await fetch(importUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${shopToken}` },
    body: form,
  });
  return { status: res.status, body: await res.json() };
};

// One bad row must stop the whole file: a half-imported inventory is worse
// than a rejected one, because the seller cannot tell which half.
const partly = await upload(
  'sku,name,price\n70000,Good skis,250.00\n99999,Out of range,180.00\n',
);
const partlyRows = partly.body.data ?? [];
ok('a file with one bad row reports it', partlyRows.some((r) => r.outcome === 'error'),
   JSON.stringify(partlyRows.map((r) => r.outcome)));
const wroteNothing = await prisma.swapItem.count({ where: { swapId: swap.id, sku: '70000' } });
ok('and writes none of the good rows either', wroteNothing === 0, String(wroteNothing));

const dupes = await upload('sku,name,price\n70001,One,10.00\n70001,Two,20.00\n');
ok('a number repeated inside the file is refused',
   (dupes.body.data ?? []).some((r) => /also on line/.test(r.error ?? '')),
   JSON.stringify((dupes.body.data ?? []).map((r) => r.error).filter(Boolean)));

// Gaps and going backwards are ordinary, not errors.
const good = await upload(
  'sku,name,price\n70005,Boots,180.00\n70002,,90.00\n70009,Poles,40.00\n',
);
const goodRows = good.body.data ?? [];
ok('a file that skips numbers and goes backwards imports cleanly',
   goodRows.length === 3 && goodRows.every((r) => r.outcome === 'created'),
   JSON.stringify(goodRows.map((r) => r.outcome)));

const imported = await prisma.swapItem.findMany({
  where: { swapId: swap.id, sku: { in: ['70005', '70002', '70009'] } },
  orderBy: { sku: 'asc' },
});
ok('every imported row landed', imported.length === 3, String(imported.length));
ok('a blank name was called by its number',
   imported.find((i) => i.sku === '70002')?.name === 'Item #70002',
   imported.find((i) => i.sku === '70002')?.name);
ok('and imported items count as printed',
   imported.every((i) => i.hasPrintedTag), JSON.stringify(imported.map((i) => i.hasPrintedTag)));

const priced = imported.find((i) => i.sku === '70005');
ok('a price with a decimal became cents', priced?.priceCents === 18000, String(priced?.priceCents));

const noPrice = await upload('sku,name,price\n70003,No price,\n');
ok('a row with no price is refused',
   (noPrice.body.data ?? []).some((r) => /needs a price/.test(r.error ?? '')),
   JSON.stringify((noPrice.body.data ?? []).map((r) => r.error)));

const noSkuColumn = await upload('name,price\nSomething,10.00\n');
// Read as rows without tickets since Plan 31: without "Generate SKUs as
// needed", each one is refused, and nothing is written.
ok('a file with no sku column imports nothing without the generate switch',
   (noSkuColumn.body.data ?? []).length > 0 && (noSkuColumn.body.data ?? []).every((r) => /needs a ticket number/.test(r.error ?? '')),
   JSON.stringify((noSkuColumn.body.data ?? []).map((r) => r.error)));

// ─── An ordinary seller cannot mint a SKU ────────────────────────────────────

const ordinaryToken = await smokeSession(prisma, BASE, shopUser, unwrap);
const plain = await fetch(itemsUrl, {
  method: 'POST',
  headers: { authorization: `Bearer ${ordinaryToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ swapId: swap.id, categoryId: category.id, priceCents: 1000, quantity: 1, sku: '12345' }),
});
ok('a seller with no ranges cannot supply a SKU', plain.status === 400, String(plain.status));

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.legacyTicketRange.deleteMany({ where: { swapId: swap.id } });
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
