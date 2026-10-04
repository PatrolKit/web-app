// Printed labels beside legacy tickets (Plan 31), against a running API and a
// real database.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-mixed-tickets.mjs
//
// A swap whose staff check-in takes legacy tickets only, while its web doesn't:
// a shop holding tickets and a printer uploads a file in which some rows have a
// ticket and some don't, and generates SKUs for the rest. Turning the web to
// tickets-only shuts that off again.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

// ─── Fixtures ────────────────────────────────────────────────────────────────
const TITLE = 'Mixed tickets smoke';
const EMAILS = ['mixed-shop@patrolkit.invalid', 'mixed-plain@patrolkit.invalid'];
const org = await smokeOrg(prisma);
await prisma.swapItem.deleteMany({ where: { swap: { title: TITLE } } });
await prisma.legacyTicketRange.deleteMany({ where: { swap: { title: TITLE } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: TITLE } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: 'Mixed shop printer' } });
for (const email of EMAILS) {
  const prior = await prisma.user.findFirst({ where: { email } });
  if (prior) await prisma.user.delete({ where: { id: prior.id } });
}

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, slug: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title: TITLE, squareCategoryId: 'mixed-smoke', skuPrefix: 'MIX', active: true, activeSkuPrefix: 'MIX',
    // The beta's shape: the counter on tickets, the web open.
    allowLegacyCheckin: true, allowLegacyWeb: true, allowPrintCheckin: false, allowPrintWeb: true,
  },
});
const category = await prisma.taxonomyNode.findFirst({ where: { kind: 'CATEGORY', label: 'Skis' } });

async function shop(email, name) {
  const user = await prisma.user.create({ data: { id: createId(), email, firstName: name, lastName: 'Shop' } });
  const m = await prisma.membership.create({ data: { id: createId(), userId: user.id, orgId: org.id, updatedAt: new Date() } });
  const seller = await prisma.sellerProfile.create({ data: { id: createId(), membershipId: m.id, businessName: name } });
  return { user, seller };
}
// A shop with tickets AND a printer: what the old rule refused.
const mixed = await shop(EMAILS[0], 'Mixed Shop');
await prisma.legacyTicketRange.create({
  data: { id: createId(), orgId: org.id, swapId: swap.id, sellerId: mixed.seller.id, startNumber: 71000, endNumber: 71099, updatedAt: new Date() },
});
await prisma.swapPrinter.create({
  data: { orgId: org.id, name: 'Mixed shop printer', bluetoothName: 'Q-MIXED', model: 'm221', paperSize: '62x100', assignedSellerId: mixed.seller.id },
});
// A shop with no tickets at all.
const plain = await shop(EMAILS[1], 'Plain Shop');

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const S = { authorization: `Bearer ${await smokeSession(prisma, BASE, staff, unwrap)}` };
const M = { authorization: `Bearer ${await smokeSession(prisma, BASE, mixed.user, unwrap)}` };
const P = { authorization: `Bearer ${await smokeSession(prisma, BASE, plain.user, unwrap)}` };
const json = (h) => ({ ...h, 'content-type': 'application/json' });

const FILE = ['sku,price,name', '71001,250.00,Ticketed skis', '71002,180.00,Ticketed boots', ',45.00,Poles', ',30.00,Goggles'].join('\n');
const selfUpload = (headers, csv, generateSkus) => {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'items.csv');
  form.append('swapId', swap.id);
  if (generateSkus) form.append('generateSkus', 'true');
  return fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items/import`, { method: 'POST', headers, body: form }).then(unwrap);
};
const staffUpload = (sellerId, csv, generateSkus) => {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'items.csv');
  form.append('sellerId', sellerId);
  if (generateSkus) form.append('generateSkus', 'true');
  return fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items/import`, { method: 'POST', headers: S, body: form }).then(unwrap);
};

// ─── The swap ────────────────────────────────────────────────────────────────
const swapNow = await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}`, { headers: S }).then(unwrap);
ok('the swap reports the two places apart', swapNow.allowPrintCheckin === false && swapNow.allowPrintWeb === true,
  `print at check-in ${swapNow.allowPrintCheckin}, on the web ${swapNow.allowPrintWeb}`);

// ─── Uploads ─────────────────────────────────────────────────────────────────
const refused = await selfUpload(M, FILE, false);
ok('without the switch, rows without a ticket fail and nothing is written',
  Array.isArray(refused) && refused.filter((r) => r.outcome === 'error').length === 2
  && (await prisma.swapItem.count({ where: { swapId: swap.id } })) === 0,
  JSON.stringify(Array.isArray(refused) ? refused.map((r) => r.outcome) : refused));

const imported = await selfUpload(M, FILE, true);
const items = await prisma.swapItem.findMany({ where: { swapId: swap.id, sellerId: mixed.seller.id }, orderBy: { createdAt: 'asc' } });
const ticketed = items.filter((i) => /^\d+$/.test(i.sku));
const generated = items.filter((i) => !/^\d+$/.test(i.sku));
ok('with it, all four import: two on tickets, two with generated SKUs',
  Array.isArray(imported) && imported.every((r) => r.outcome === 'created') && ticketed.length === 2 && generated.length === 2,
  `${ticketed.map((i) => i.sku)} / ${generated.map((i) => i.sku)}`);
ok('...the tickets marked printed, the generated ones not',
  ticketed.every((i) => i.hasPrintedTag) && generated.every((i) => !i.hasPrintedTag));
ok('...and the result names each generated SKU', imported.filter?.((r) => r.generated).every((r) => generated.some((i) => i.sku === r.sku)));

// Printing a label from the web activates a web-made item: no counter scan.
ok('a shop’s generated items wait until their label is printed', generated.every((i) => i.consignedAt === null));
const printed = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items/${generated[0].id}`, {
  method: 'PATCH', headers: json(M), body: JSON.stringify({ hasPrintedTag: true }),
}).then(unwrap);
const afterPrint = await prisma.swapItem.findUnique({ where: { id: generated[0].id } });
ok('...and printing one accepts it, by the shop, with no scan', !!afterPrint.consignedAt && afterPrint.consignedBy === mixed.user.id && printed.consignedAt,
  `${afterPrint.consignedAt?.toISOString()} by ${afterPrint.consignedBy}`);
await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items/${ticketed[0].id}`, {
  method: 'PATCH', headers: json(M), body: JSON.stringify({ hasPrintedTag: true }),
});
ok('...while a ticket item still waits for the counter', (await prisma.swapItem.findUnique({ where: { id: ticketed[0].id } })).consignedAt === null);

const pickable = await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items/ticket-sellers`, { headers: S }).then(unwrap);
ok('staff can upload for a shop without tickets while the web is open', pickable.some((s) => s.sellerId === plain.seller.id),
  JSON.stringify(pickable.map((s) => s.displayName)));
const forPlain = await staffUpload(plain.seller.id, 'price,name\n20.00,Wax\n', true);
ok('...and its rows all get generated SKUs', Array.isArray(forPlain) && forPlain[0]?.generated === true && forPlain[0]?.outcome === 'created',
  JSON.stringify(forPlain));

// ─── Hand entry ──────────────────────────────────────────────────────────────
const handTicket = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items`, {
  method: 'POST', headers: json(M), body: JSON.stringify({ swapId: swap.id, categoryId: category?.id, priceCents: 9900, quantity: 1 }),
}).then(unwrap);
const handLabel = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items`, {
  method: 'POST', headers: json(M), body: JSON.stringify({ swapId: swap.id, categoryId: category?.id, priceCents: 9900, quantity: 1, generateSku: true }),
}).then(unwrap);
ok('by hand, a ticket seller still takes the next ticket by default', /^\d+$/.test(handTicket.sku ?? '') && handTicket.legacyTicket === true, handTicket.sku);
ok('...and gets a generated SKU, with a label to print, when asked', !/^\d+$/.test(handLabel.sku ?? '') && handLabel.legacyTicket === false && handLabel.hasPrintedTag === false,
  handLabel.sku);

// ─── The web turned tickets-only ─────────────────────────────────────────────
await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}`, { method: 'PATCH', headers: json(S), body: JSON.stringify({ allowPrintWeb: false }) });
const noGen = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items`, {
  method: 'POST', headers: json(M), body: JSON.stringify({ swapId: swap.id, categoryId: category?.id, priceCents: 9900, quantity: 1, generateSku: true }),
});
ok('then a generated SKU by hand is refused', noGen.status === 400, `HTTP ${noGen.status}`);
const noGenUpload = await selfUpload(M, 'price,name\n10.00,Strap\n', true);
ok('...so is generating on upload', typeof noGenUpload?.error === 'string' && /legacy tickets only/.test(noGenUpload.error), noGenUpload?.error);
const plainHand = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items`, {
  method: 'POST', headers: json(P), body: JSON.stringify({ swapId: swap.id, categoryId: category?.id, priceCents: 9900, quantity: 1 }),
});
const plainBody = await plainHand.json();
ok('...and a shop without tickets can’t add anything', plainHand.status === 400 && /block of tickets/.test(plainBody.error ?? ''),
  `HTTP ${plainHand.status}: ${plainBody.error}`);
const pickableLater = await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items/ticket-sellers`, { headers: S }).then(unwrap);
ok('...and staff are offered only ticket holders to upload for', !pickableLater.some((s) => s.sellerId === plain.seller.id));
const swapAfter = await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}`, { headers: S }).then(unwrap);
ok('the counter’s setting, what the iPad reads, never moved', swapAfter.allowPrintCheckin === false);

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.legacyTicketRange.deleteMany({ where: { swapId: swap.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: 'Mixed shop printer' } });
for (const email of EMAILS) await prisma.user.deleteMany({ where: { email } });
await prisma.$disconnect();

console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
