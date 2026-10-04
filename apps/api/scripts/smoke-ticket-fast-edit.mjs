// Plan 37 against a running API and real database, in the smoke org only: the
// list of tickets still waiting for a price, a price saved with a typed
// description, and `ifUnpriced` refusing a ticket that already has one.
//
// The smoke org has no Square, so nothing here reaches a catalog.
//
//   SMOKE_BASE=https://patrolkit.io/api/v1 node apps/api/scripts/smoke-ticket-fast-edit.mjs

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

const TITLE = 'Fast edit smoke swap';
const org = await smokeOrg(prisma);
async function tidy() {
  const swaps = await prisma.skiSwap.findMany({ where: { orgId: org.id, title: TITLE }, select: { id: true } });
  for (const s of swaps) await prisma.swapItem.deleteMany({ where: { swapId: s.id } });
  await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: TITLE } });
}
await tidy();

const swap = await prisma.skiSwap.create({
  data: { orgId: org.id, title: TITLE, squareCategoryId: 'fast-edit-smoke', skuPrefix: 'FES',
    slug: `fes${Date.now().toString(36)}`, active: true, activeSkuPrefix: 'FES', allowLegacyWeb: true },
});
const item = (sku, extra = {}) => prisma.swapItem.create({
  data: { id: createId(), swapId: swap.id, orgId: org.id, name: `Item #${sku}`, sku, liveSku: sku,
    priceCents: null, originalQuantity: 1, consignedAt: new Date(), ...extra },
});
const unpricedA = await item('91502');
await item('91501', { name: 'Old skis' });
const priced = await item('91503', { priceCents: 4500 });
await item('91504', { deletedAt: new Date(), liveSku: null });
await item('FES-A-0001');

const { user: staffUser } = await smokeStaff(prisma, org, ['ski_swap:manage', 'ski_swap:report']);
const SH = { authorization: `Bearer ${await smokeSession(prisma, BASE, staffUser, unwrap)}`, 'content-type': 'application/json' };
const itemsUrl = `${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`;
const listUnpriced = () => fetch(`${itemsUrl}/unpriced-tickets`, { headers: SH }).then(unwrap);
const patch = (id, body) => fetch(`${itemsUrl}/${id}`, { method: 'PATCH', headers: SH, body: JSON.stringify(body) });

// ─── The list ────────────────────────────────────────────────────────────────

const list = await listUnpriced();
ok('lists unpriced tickets in number order, leaving out priced, withdrawn and non-ticket items',
  JSON.stringify(list.map((t) => t.sku)) === JSON.stringify(['91501', '91502']), JSON.stringify(list.map((t) => t.sku)));
ok('...saying which still have a stand-in name',
  list.find((t) => t.sku === '91502')?.placeholderName === true && list.find((t) => t.sku === '91501')?.placeholderName === false);

// ─── Saving ──────────────────────────────────────────────────────────────────

const taxonomy = await fetch(`${BASE}/orgs/${org.id}/ski-swap/taxonomy`, { headers: SH }).then(unwrap);
const category = taxonomy.categories.find((c) => c.attributes.some((a) => a.input === 'select' && a.values?.length));
const attribute = category.attributes.find((a) => a.input === 'select' && a.values?.length);
const saved = await patch(unpricedA.id, {
  priceCents: 4500, ifUnpriced: true,
  categoryId: category.id, attributes: [{ attributeId: attribute.id, valueId: attribute.values[0].id }],
  name: 'Smoke typed name 170 demo',
});
const savedBody = await unwrap(saved);
ok('a price saves with the typed description', saved.ok && savedBody.priceCents === 4500, `HTTP ${saved.status}`);
ok('...keeping the name as typed', savedBody.name === 'Smoke typed name 170 demo', savedBody.name);
ok('...and the picked category and answer', savedBody.category?.id === category.id &&
  savedBody.attributes?.some((a) => a.attributeId === attribute.id && a.valueId === attribute.values[0].id),
  JSON.stringify({ category: savedBody.category, attributes: savedBody.attributes?.length }));
ok('...and it leaves the list', JSON.stringify((await listUnpriced()).map((t) => t.sku)) === JSON.stringify(['91501']));

// ─── Never over a price ──────────────────────────────────────────────────────

const refused = await patch(priced.id, { priceCents: 5000, ifUnpriced: true });
const refusedBody = await refused.json();
ok('a ticket that already has a price is refused', refused.status === 409 && refusedBody.code === 'TICKET_PRICED',
  `HTTP ${refused.status} ${refusedBody.code}`);
ok('...saying what it is', /already has a price \(\$45\.00\)/.test(refusedBody.error ?? ''), refusedBody.error);
const kept = await prisma.swapItem.findUnique({ where: { id: priced.id }, select: { priceCents: true } });
ok('...and its price is untouched', kept.priceCents === 4500, String(kept.priceCents));

await tidy();
console.log(failed ? `${failed} failed` : 'All assertions passed');
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
