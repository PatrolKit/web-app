// Staff uploading a shop's inventory for them, and adding a shop without
// writing to it — against a running API and real database.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-proxy-import.mjs
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
await prisma.swapItem.deleteMany({ where: { swap: { title: 'Proxy import smoke' } } });
await prisma.legacyTicketRange.deleteMany({ where: { swap: { title: 'Proxy import smoke' } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Proxy import smoke' } });
for (const email of ['proxy-a@patrolkit.invalid', 'proxy-b@patrolkit.invalid', 'proxy-silent@patrolkit.invalid']) {
  const prior = await prisma.user.findFirst({ where: { email } });
  if (prior) await prisma.user.delete({ where: { id: prior.id } });
}
await prisma.sellerProfile.deleteMany({ where: { businessName: 'Quiet Shop', membership: { orgId: org.id } } });

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, slug: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title: 'Proxy import smoke', squareCategoryId: 'proxy-smoke',
    skuPrefix: 'PRX', active: true, activeSkuPrefix: 'PRX', legacyTicketsEnabled: true,
    // Tickets only on the web, so the picker keeps to ticket holders. With it
    // off, every business seller is offered (Plan 31; smoke-mixed-tickets).
    webLegacyTicketsOnly: true,
  },
});

async function shop(email, name, start, end) {
  const user = await prisma.user.create({ data: { id: createId(), email, firstName: name, lastName: 'Shop' } });
  const m = await prisma.membership.create({ data: { id: createId(), userId: user.id, orgId: org.id, updatedAt: new Date() } });
  const seller = await prisma.sellerProfile.create({ data: { id: createId(), membershipId: m.id, businessName: name } });
  await prisma.legacyTicketRange.create({
    data: { id: createId(), orgId: org.id, swapId: swap.id, sellerId: seller.id, startNumber: start, endNumber: end, updatedAt: new Date() },
  });
  return { user, seller };
}

const alpine = await shop('proxy-a@patrolkit.invalid', 'Alpine Sports', 67000, 67499);
const summit = await shop('proxy-b@patrolkit.invalid', 'Summit Gear', 68000, 68499);

// A seller with no ranges at all, who must not be offered.
const noRangeUser = await prisma.user.create({ data: { id: createId(), email: 'proxy-silent@patrolkit.invalid', firstName: 'No', lastName: 'Ranges' } });
const noRangeM = await prisma.membership.create({ data: { id: createId(), userId: noRangeUser.id, orgId: org.id, updatedAt: new Date() } });
await prisma.sellerProfile.create({ data: { id: createId(), membershipId: noRangeM.id, businessName: 'Quiet Shop' } });

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const token = await smokeSession(prisma, BASE, staff, unwrap);
const H = { authorization: `Bearer ${token}` };
const JH = { ...H, 'content-type': 'application/json' };

const itemsUrl = `${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`;

const upload = (sellerId, csv) => {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'items.csv');
  form.append('sellerId', sellerId);
  return fetch(`${itemsUrl}/import`, { method: 'POST', headers: H, body: form });
};

// ─── Who may be uploaded for ─────────────────────────────────────────────────

const sellers = await fetch(`${itemsUrl}/ticket-sellers`, { headers: H }).then(unwrap);
ok('the picker lists only sellers holding tickets', sellers.length === 2,
   JSON.stringify(sellers.map((s) => s.displayName)));
ok('and not one with no ranges', !sellers.some((s) => s.displayName === 'Quiet Shop'),
   JSON.stringify(sellers.map((s) => s.displayName)));

const listed = sellers.find((s) => s.displayName === 'Alpine Sports');
ok('it reports their blocks', listed?.ranges?.[0]?.startNumber === 67000, JSON.stringify(listed?.ranges));
ok('and how many are spent', listed?.usedCount === 0 && listed?.ticketCount === 500,
   `${listed?.usedCount} of ${listed?.ticketCount}`);

// ─── A good file ─────────────────────────────────────────────────────────────

const good = await upload(alpine.seller.id, [
  'sku,price,name,description',
  '67169,250.00,Rossignol Experience 88,"170cm, edges good"',
  '67170,180.00,Salomon QST boots,27.5 mondo',
  '67171,45.00,,Poles',
].join('\n')).then(unwrap);
ok('a shop’s file imports', good.every?.((r) => r.outcome === 'created'),
   JSON.stringify(good.map?.((r) => r.outcome)));

const rows = await prisma.swapItem.findMany({
  where: { swapId: swap.id, sellerId: alpine.seller.id },
  orderBy: { sku: 'asc' },
});
ok('every item belongs to the chosen seller', rows.length === 3, String(rows.length));

// The bug this plan started from: imported items used to carry no consignment
// and never reach Square, so a shop's whole inventory sat unsellable.
ok('AND EVERY IMPORTED ITEM IS CONSIGNED', rows.every((r) => r.consignedAt !== null),
   JSON.stringify(rows.map((r) => r.consignedAt !== null)));
ok('and carries its printed tag', rows.every((r) => r.hasPrintedTag === true),
   JSON.stringify(rows.map((r) => r.hasPrintedTag)));

ok('a description lands in its own field, not the name',
   rows[0].name === 'Rossignol Experience 88' && rows[0].description === '170cm, edges good',
   `${rows[0].name} / ${rows[0].description}`);
// Called by its number since Plan 20 (36bd10d), like any uncategorised item.
ok('a blank name is called by its number', rows[2].name === 'Item #67171', rows[2].name);

const after = await fetch(`${itemsUrl}/ticket-sellers`, { headers: H }).then(unwrap);
ok('the picker counts what was spent', after.find((s) => s.displayName === 'Alpine Sports')?.usedCount === 3,
   String(after.find((s) => s.displayName === 'Alpine Sports')?.usedCount));

// ─── The wrong shop ──────────────────────────────────────────────────────────

const wrong = await upload(summit.seller.id, 'sku,price\n67200,50.00\n').then(unwrap);
ok('another shop’s numbers are refused', wrong[0]?.outcome === 'error', JSON.stringify(wrong[0]));
ok('and the message names the blocks they do hold',
   (wrong[0]?.error ?? '').includes('68000'), String(wrong[0]?.error));
ok('and nothing was written for them',
   (await prisma.swapItem.count({ where: { swapId: swap.id, sellerId: summit.seller.id } })) === 0);

// ─── Partly-bad files write nothing ──────────────────────────────────────────

const mixed = await upload(alpine.seller.id, 'sku,price\n67180,20.00\n67169,30.00\n').then(unwrap);
ok('a file with one used ticket imports none of it',
   mixed.some((r) => r.outcome === 'error') && !mixed.some((r) => r.outcome === 'created'),
   JSON.stringify(mixed.map((r) => r.outcome)));
ok('so the item count has not moved',
   (await prisma.swapItem.count({ where: { swapId: swap.id } })) === 3);

const unquoted = await upload(alpine.seller.id, 'sku,price,description\n67181,20.00,170cm, edges good\n');
const unquotedBody = await unquoted.json();
ok('an unquoted comma is explained, not a 500', unquoted.status === 400, String(unquoted.status));
ok('and says to quote it', (unquotedBody.error ?? '').includes('quotes'), String(unquotedBody.error));

// ─── The swap switch ─────────────────────────────────────────────────────────

await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}`, {
  method: 'PATCH', headers: JH, body: JSON.stringify({ legacyTicketsEnabled: false }),
});
const off = await upload(alpine.seller.id, 'sku,price\n67182,20.00\n');
ok('a swap that does not take legacy tickets refuses the upload', off.status === 400, String(off.status));
await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}`, {
  method: 'PATCH', headers: JH, body: JSON.stringify({ legacyTicketsEnabled: true }),
});

// ─── Adding a shop without writing to it ─────────────────────────────────────

const bsUrl = `${BASE}/orgs/${org.id}/ski-swap/business-sellers`;

const silent = await fetch(bsUrl, {
  method: 'POST', headers: JH, body: JSON.stringify({ businessName: 'Nameless Shop' }),
});
ok('a business seller can be added with no email at all', silent.status === 201 || silent.status === 200,
   String(silent.status));
const silentBody = await silent.json();
ok('and appears as a business seller', silentBody.data?.businessName === 'Nameless Shop',
   JSON.stringify(silentBody.data ?? silentBody));

const withEmail = await fetch(bsUrl, {
  method: 'POST', headers: JH,
  body: JSON.stringify({ businessName: 'Quiet Corner', email: 'proxy-quiet@patrolkit.invalid' }),
});
ok('an email can be recorded without asking to send', withEmail.status === 201 || withEmail.status === 200,
   String(withEmail.status));

const noAddress = await fetch(bsUrl, {
  method: 'POST', headers: JH,
  body: JSON.stringify({ businessName: 'Impossible Shop', sendInvite: true }),
});
ok('asking to send with no address is refused', noAddress.status === 400, String(noAddress.status));

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.legacyTicketRange.deleteMany({ where: { swapId: swap.id } });
await prisma.swapSkuCounter.deleteMany({ where: { swapId: swap.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.user.delete({ where: { id: alpine.user.id } });
await prisma.user.delete({ where: { id: summit.user.id } });
await prisma.user.delete({ where: { id: noRangeUser.id } });
for (const name of ['Nameless Shop', 'Quiet Corner']) {
  const p = await prisma.sellerProfile.findFirst({ where: { businessName: name, membership: { orgId: org.id } }, include: { membership: true } });
  if (p) await prisma.user.delete({ where: { id: p.membership.userId } });
}
const quiet = await prisma.user.findFirst({ where: { email: 'proxy-quiet@patrolkit.invalid' } });
if (quiet) await prisma.user.delete({ where: { id: quiet.id } });
await prisma.$disconnect();
