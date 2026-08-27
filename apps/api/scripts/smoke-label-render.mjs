// Renders every label kind through the browser-facing endpoint and checks the
// bytes look like what a Phomemo expects.
//
// The renderer has no natural assertion beyond its golden fixtures, which cover
// layout; this covers the wiring around it — auth, printer resolution, recipe
// lookup, and the two output formats.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-label-render.mjs

//
// Sign-in endpoints are throttled to five attempts a minute, so back-to-back
// runs return 429 and look like a regression. Leave a minute between them.
import { PrismaClient } from '@prisma/client';

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const org = await smokeOrg(prisma);
const { user: staff } = await smokeStaff(prisma, org, [
  'ski_swap:admin', 'ski_swap:manage', 'ski_swap:report',
]);

const accessToken = await smokeSession(prisma, BASE, staff, unwrap);
ok('signed in', !!accessToken);
const H = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };

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

// A printer belonging to another org is invisible, whether or not the caller
// has any standing there.
const otherOrg = await prisma.organization.findFirst({ where: { id: { not: org.id } } });
if (otherOrg) {
  const foreign = await fetch(`${BASE}/orgs/${otherOrg.id}/ski-swap/printers/${printer.id}/labels`, {
    method: 'POST', headers: H, body: JSON.stringify({ kind: 'calibration' }),
  });
  ok('cross-org render is refused', foreign.status >= 400, String(foreign.status));
} else {
  console.log('SKIP  cross-org render — only one org exists on this database');
}

await prisma.swapPrinter.delete({ where: { id: printer.id } });
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.$disconnect();
