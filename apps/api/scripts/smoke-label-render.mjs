// Renders every label kind through the browser-facing endpoint and checks the
// bytes look like what a Phomemo expects.
//
// The renderer has no natural assertion beyond its golden fixtures, which cover
// layout; this covers the wiring around it — auth, printer resolution, recipe
// lookup, and the two output formats.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-label-render.mjs

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const org = await prisma.organization.findFirst();
const admin = await prisma.user.findFirst({
  where: { memberships: { some: { orgId: org.id, deletedAt: null } }, email: { not: null } },
});

// Dev-only: the sign-in code comes back in the response when outbound
// notifications are off and NODE_ENV is not production.
const start = await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: admin.email }),
}).then(unwrap);
ok('sign-in code issued in dev', !!start.devCode, start.devCode ? '' : JSON.stringify(start));

const session = await fetch(`${BASE}/auth/challenges/${start.challengeId}/confirm`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: start.devCode }),
}).then(unwrap);
const H = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' };
ok('signed in', !!session.accessToken);

await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: 'Render smoke' } });
const printer = await prisma.swapPrinter.create({
  data: { orgId: org.id, name: 'Render smoke', bluetoothName: 'M110-RENDER' },
});

// Fixtures for the seller-shaped labels. Created here rather than assumed,
// because a freshly seeded database has no swap in it.
await prisma.swapItem.deleteMany({ where: { orgId: org.id, sku: { startsWith: 'RS-' } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Render smoke swap' } });

const membership = await prisma.membership.findFirst({
  where: { orgId: org.id, deletedAt: null },
});
const seller = await prisma.sellerProfile.upsert({
  where: { membershipId: membership.id },
  update: { deletedAt: null },
  create: { membershipId: membership.id },
});
const swap = await prisma.skiSwap.create({
  data: { orgId: org.id, title: 'Render smoke swap', squareCategoryId: 'smoke', skuPrefix: 'RS' },
});
const item = await prisma.swapItem.create({
  data: {
    swapId: swap.id, orgId: org.id, sellerId: seller.id,
    name: 'Volkl Kendo 88 skis, 177cm', priceCents: 24900,
    sku: 'RS-S-0001', originalQuantity: 1,
  },
});
// A long name and a full-width SKU are where layout breaks, so print one.
await prisma.swapItem.create({
  data: {
    swapId: swap.id, orgId: org.id, sellerId: seller.id,
    name: 'Black Diamond Recon LT climbing harness, size medium',
    priceCents: 8950, sku: 'RS-S-0002', originalQuantity: 1,
  },
});

const render = (body) =>
  fetch(`${BASE}/orgs/${org.id}/ski-swap/printers/${printer.id}/labels`, {
    method: 'POST', headers: H, body: JSON.stringify(body),
  });

for (const [label, body, expectPages] of [
  ['calibration', { kind: 'calibration' }, 1],
  ['printer label', { kind: 'printer_label' }, 1],
  ['item tag', { kind: 'item', itemId: item.id }, 1],
  ['seller QR', { kind: 'qr', sellerId: seller.id }, 1],
  ['receipt header', { kind: 'receipt_header', sellerId: seller.id }, 1],
  ['receipt items', { kind: 'receipt_items', sellerId: seller.id, swapId: swap.id }, 1],
]) {
  const res = await render(body);
  const out = await unwrap(res);
  if (res.status !== 200) { ok(label, false, `${res.status} ${JSON.stringify(out)}`); continue; }
  const bytes = Buffer.from(out.pages[0], 'base64');
  ok(label, out.pages.length === expectPages && bytes[0] === 0x1b && bytes[1] === 0x40,
     `${out.pages.length} page(s), ${bytes.length} bytes`);
}

// PNG preview: same render, different encoding.
const png = await render({ kind: 'calibration', format: 'png' }).then(unwrap);
const pngBytes = Buffer.from(png.pages[0], 'base64');
ok('png preview is a PNG', pngBytes.subarray(1, 4).toString() === 'PNG', `${pngBytes.length} bytes`);

// A recipe that names nothing is rejected rather than printing a blank tag.
const bad = await render({ kind: 'item' });
ok('item tag with no item is rejected', bad.status === 400, String(bad.status));

// A printer in another org is invisible.
const otherOrg = await prisma.organization.findFirst({ where: { id: { not: org.id } } });
if (otherOrg) {
  const foreign = await fetch(`${BASE}/orgs/${otherOrg.id}/ski-swap/printers/${printer.id}/labels`, {
    method: 'POST', headers: H, body: JSON.stringify({ kind: 'calibration' }),
  });
  ok('cross-org render is refused', foreign.status === 403 || foreign.status === 404, String(foreign.status));
}

await prisma.swapPrinter.delete({ where: { id: printer.id } });
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.$disconnect();
