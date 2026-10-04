// A legacy ticket checked in before it has a price (Plan 32), against a running
// API and real database, in the smoke org only.
//
// Square isn't configured for the smoke org, so this covers everything up to
// Square; what goes to Square is covered by unit tests on the adapter, and the
// register's prompt by a one-off check on a real register.
//
//   SMOKE_BASE=https://patrolkit.io/api/v1 node apps/api/scripts/smoke-unpriced-tickets.mjs

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
let failed = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

const TITLE = 'Unpriced ticket smoke swap';
const SHOP_EMAIL = 'unpriced-shop@patrolkit.invalid';
const org = await smokeOrg(prisma);

await prisma.receipt.deleteMany({ where: { orgId: org.id, swap: { title: TITLE } } });
await prisma.swapItem.deleteMany({ where: { orgId: org.id, swap: { title: TITLE } } });
await prisma.legacyTicketRange.deleteMany({ where: { orgId: org.id, swap: { title: TITLE } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: TITLE } });
await prisma.user.deleteMany({ where: { email: SHOP_EMAIL } });

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, slug: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title: TITLE, squareCategoryId: 'unpriced-smoke',
    skuPrefix: 'UPS', active: true, activeSkuPrefix: 'UPS', allowLegacyCheckin: true, allowLegacyWeb: true,
  },
});
const shopUser = await prisma.user.create({ data: { id: createId(), email: SHOP_EMAIL, firstName: 'Shop', lastName: 'Owner' } });
const membership = await prisma.membership.create({
  data: { id: createId(), userId: shopUser.id, orgId: org.id, updatedAt: new Date() },
});
const shop = await prisma.sellerProfile.create({
  data: { id: createId(), membershipId: membership.id, businessName: 'Unpriced Smoke Sports' },
});
await prisma.legacyTicketRange.create({
  data: { id: createId(), orgId: org.id, swapId: swap.id, sellerId: shop.id, startNumber: 81000, endNumber: 81099, updatedAt: new Date() },
});

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const SH = { authorization: `Bearer ${await smokeSession(prisma, BASE, staff, unwrap)}`, 'content-type': 'application/json' };
const H = { authorization: `Bearer ${await smokeSession(prisma, BASE, shopUser, unwrap)}`, 'content-type': 'application/json' };
const itemsUrl = `${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`;
const cursor = new Date(Date.now() - 1000).toISOString();

// ─── Staff check-in, as the iPad sends it ────────────────────────────────────

const scanned = await fetch(itemsUrl, {
  method: 'POST', headers: SH,
  body: JSON.stringify({ name: 'Scanned skis', quantity: 1, sku: '81000', alreadyPrinted: true, sellerId: shop.id }),
});
const scannedItem = await unwrap(scanned);
ok('staff can check in a ticket with no price', scanned.ok, `HTTP ${scanned.status}`);
ok('...and it has no price, not $0', scannedItem.priceCents === null, String(scannedItem.priceCents));

const noTicket = await fetch(itemsUrl, {
  method: 'POST', headers: SH, body: JSON.stringify({ quantity: 1, sellerId: shop.id }),
});
ok('an item with a generated SKU still needs a price', noTicket.status === 400, `HTTP ${noTicket.status}`);
ok('...and is told why', /Only a legacy ticket/.test((await noTicket.json()).error ?? ''));

const delta = await fetch(`${itemsUrl}?take=200&updatedSince=${encodeURIComponent(cursor)}`, { headers: SH }).then(unwrap);
ok('a delta carries the unpriced ticket with no price',
  delta.items?.some((i) => i.sku === '81000' && i.priceCents === null), JSON.stringify(delta.items?.map((i) => [i.sku, i.priceCents])));

// ─── A shop entering tickets by hand ─────────────────────────────────────────

const handUrl = `${BASE}/orgs/${org.id}/ski-swap/seller/me/items`;
const byHand = await fetch(handUrl, { method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, quantity: 1 }) });
const handItem = await unwrap(byHand);
ok('a shop can enter a ticket with no price', byHand.ok && handItem.priceCents === null,
  `HTTP ${byHand.status} ${JSON.stringify({ sku: handItem.sku, priceCents: handItem.priceCents })}`);
ok('...on its next ticket', /^\d+$/.test(handItem.sku ?? ''), handItem.sku);

const labelNoPrice = await fetch(handUrl, {
  method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, quantity: 1, generateSku: true }),
});
ok('a printed label still needs a price', labelNoPrice.status === 400, `HTTP ${labelNoPrice.status}`);

// ─── Staff uploading a file for the shop ─────────────────────────────────────

const upload = async (csv, generateSkus = false) => {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'items.csv');
  form.append('sellerId', shop.id);
  if (generateSkus) form.append('generateSkus', 'true');
  const res = await fetch(`${itemsUrl}/import`, { method: 'POST', headers: { authorization: SH.authorization }, body: form });
  return { status: res.status, rows: (await unwrap(res)) ?? [] };
};
const noColumn = await upload('sku,name\n81050,Boots\n81051,Poles\n');
ok('a file of tickets with no price column imports', Array.isArray(noColumn.rows) && noColumn.rows.every((r) => r.outcome === 'created'),
  JSON.stringify(noColumn.rows));
const mixed = await upload('sku,name,price\n81060,Helmet,\n,Goggles,\n', true);
ok('a generated-SKU row without a price is refused, and nothing is written',
  Array.isArray(mixed.rows) && mixed.rows.some((r) => /needs a price/.test(r.error ?? '')) &&
  (await prisma.swapItem.count({ where: { swapId: swap.id, sku: '81060' } })) === 0,
  JSON.stringify(mixed.rows));

// ─── A receipt, then pricing it ──────────────────────────────────────────────

const receiptUrl = `${BASE}/orgs/${org.id}/ski-swap/sellers/${shop.id}/receipts`;
const receipt = await fetch(receiptUrl, { method: 'POST', headers: SH, body: JSON.stringify({ swapId: swap.id }) }).then(unwrap);
ok('a receipt lists unpriced tickets as unpriced',
  receipt.unpricedCount === 4 && receipt.lines?.every((l) => l.priceCents === null) && receipt.totalCents === 0,
  JSON.stringify({ unpricedCount: receipt.unpricedCount, totalCents: receipt.totalCents }));

const patched = await fetch(`${itemsUrl}/${scannedItem.id}`, { method: 'PATCH', headers: SH, body: JSON.stringify({ priceCents: 25000 }) });
ok('staff can price it later', patched.ok && (await unwrap(patched)).priceCents === 25000, `HTTP ${patched.status}`);

const reissued = await fetch(receiptUrl, { method: 'POST', headers: SH, body: JSON.stringify({ swapId: swap.id }) }).then(unwrap);
ok('...and the next receipt totals it', reissued.totalCents === 25000 && reissued.unpricedCount === 3,
  JSON.stringify({ unpricedCount: reissued.unpricedCount, totalCents: reissued.totalCents }));

const cleared = await fetch(`${itemsUrl}/${scannedItem.id}`, { method: 'PATCH', headers: SH, body: JSON.stringify({ priceCents: null }) });
ok('a price, once set, can’t be cleared', cleared.status === 400, `HTTP ${cleared.status}`);

await prisma.receipt.deleteMany({ where: { swapId: swap.id } });
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.legacyTicketRange.deleteMany({ where: { swapId: swap.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.user.delete({ where: { id: shopUser.id } });
console.log(failed ? `${failed} failed` : 'All assertions passed');
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
