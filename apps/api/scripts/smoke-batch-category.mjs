// Batch set category (Plan 45), against a running API. Test org only.
//
//   node apps/api/scripts/smoke-batch-category.mjs           # runs, then cleans up
//   node apps/api/scripts/smoke-batch-category.mjs --keep    # leaves the swap for a UI run
//
// What a unit test can't reach: the route and its guards, the real resolver
// validating a pick against the tree, the conditional write against MySQL,
// and that nothing but the category, its answers and (asked for) the name
// changes. Its swap has no Square location, so nothing reaches Square.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const KEEP = process.argv.includes('--keep');
const unwrap = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (l, c, e = '') => { if (!c) failures++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`); };

const org = await smokeOrg(prisma);
const TITLE = 'Batch category smoke swap';
await prisma.swapItem.deleteMany({ where: { orgId: org.id, swap: { title: TITLE } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: TITLE } });

// A real category from the shared tree, and a select question with a value under it.
const skis = await prisma.taxonomyNode.findFirst({ where: { orgId: null, kind: 'CATEGORY', label: 'Skis', parentId: null, retiredAt: null } });
const boots = await prisma.taxonomyNode.findFirst({ where: { orgId: null, kind: 'CATEGORY', label: 'Ski boots', parentId: null, retiredAt: null } })
  ?? await prisma.taxonomyNode.findFirst({ where: { orgId: null, kind: 'CATEGORY', parentId: null, retiredAt: null, NOT: { id: skis?.id } } });
const included = skis && await prisma.taxonomyNode.findFirst({ where: { parentId: skis.id, kind: 'ATTRIBUTE', label: 'Bindings included' } });
const yes = included && await prisma.taxonomyNode.findFirst({ where: { parentId: included.id, kind: 'VALUE', label: 'Yes' } });
if (!skis || !boots || !included || !yes) throw new Error('The shared tree has no Skis › Bindings included › Yes to pick');

const swap = await prisma.skiSwap.create({
  data: { orgId: org.id, slug: `bc${Date.now().toString(36)}`, title: TITLE, squareCategoryId: 'bc-cat', locationId: '', skuPrefix: 'BC', active: true, activeSkuPrefix: 'BC' },
});
const item = (sku, over = {}) => prisma.swapItem.create({
  data: { id: createId(), swapId: swap.id, orgId: org.id, sku, liveSku: sku, name: `Item #${sku}`, priceCents: 3500, originalQuantity: 1, consignedAt: new Date(), ...over },
});
const bare = await item('BC-0001');
const bare2 = await item('BC-0002');
const already = await item('BC-0003', { categoryId: boots.id, name: 'Ski boots' });
for (let i = 4; i <= 12; i++) await item(`BC-${String(i).padStart(4, '0')}`);

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:manage', 'ski_swap:report', 'org:read']);
const token = await smokeSession(prisma, BASE, staff, unwrap);
const ITEMS = `/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`;
const post = (p, body) => fetch(`${BASE}${ITEMS}${p}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const PICK = { categoryId: skis.id, attributes: [{ attributeId: included.id, valueId: yes.id }] };

console.log('\n── Set, skip, not found ─────────────────────────────');
const r1 = await post('/categorize', { ...PICK, skus: ['BC-0001', 'BC-0003', 'BC-9999', 'BC-0001'] });
const { results } = await unwrap(r1);
ok('a batch answers each distinct tag once', r1.status === 200 && results?.length === 3, `HTTP ${r1.status} ${results?.length}`);
ok('...sets the one with no category', results?.[0]?.outcome === 'set' && results[0].item?.categoryLabel === 'Skis', JSON.stringify(results?.[0]));
ok('...skips the one that has one, saying which', results?.[1]?.outcome === 'skipped' && results[1].item?.categoryLabel === boots.label);
ok('...and says not found', results?.[2]?.outcome === 'not_found');
const after = await prisma.swapItem.findUnique({ where: { id: bare.id }, include: { attributes: true } });
ok('the item has the category and the answer', after?.categoryId === skis.id && after.attributes.length === 1 && after.attributes[0].valueId === yes.id);
ok('...and nothing else changed', after?.name === 'Item #BC-0001' && after.priceCents === 3500 && after.consignedAt !== null);
ok('the skipped one is untouched', (await prisma.swapItem.findUnique({ where: { id: already.id } }))?.categoryId === boots.id);

console.log('\n── Refusals ─────────────────────────────────────────');
const typed = await post('/categorize', { categoryId: skis.id, attributes: [{ attributeId: included.id, freeText: 'Yess' }], skus: ['BC-0002'] });
ok('a typed value is refused', typed.status === 400, `HTTP ${typed.status}`);
const wrong = await post('/categorize', { categoryId: boots.id, attributes: [{ attributeId: included.id, valueId: yes.id }], skus: ['BC-0002'] });
ok('a pick the category doesn’t ask is refused for the batch', wrong.status === 400, `HTTP ${wrong.status}`);
ok('...and nothing was set', (await prisma.swapItem.findUnique({ where: { id: bare2.id } }))?.categoryId === null);

console.log('\n── Rename, and undo ─────────────────────────────────');
const r2 = await unwrap(await post('/categorize', { ...PICK, rename: true, skus: ['BC-0002'] }));
const renamed = r2.results?.[0]?.item;
ok('with rename, the item takes the derived name', r2.results?.[0]?.outcome === 'set' && renamed?.previousName === 'Item #BC-0002' && renamed.name && renamed.name !== 'Item #BC-0002', JSON.stringify(renamed));
const undo = await post(`/${bare2.id}/uncategorize`, { ...PICK, rename: { from: 'Item #BC-0002', to: renamed?.name } });
const undone = await unwrap(undo);
const back = await prisma.swapItem.findUnique({ where: { id: bare2.id }, include: { attributes: true } });
ok('undo clears the category and puts the name back', undo.status === 200 && undone.nameRestored && back?.categoryId === null && back.attributes.length === 0 && back.name === 'Item #BC-0002');
const undo1 = await post(`/${bare.id}/uncategorize`, { categoryId: skis.id, attributes: [] });
ok('undo is refused once the answers differ from what was set', undo1.status === 409, `HTTP ${undo1.status}`);
ok('...and the audit has the batches', (await prisma.auditLog.count({ where: { orgId: org.id, action: 'ski_swap.items.categorized', targetId: swap.id } })) === 2);

if (KEEP) {
  console.log(`\nKept: swap ${swap.id} ("${TITLE}"), tags BC-0004…BC-0012 uncategorized for a UI run.`);
} else {
  await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
  await prisma.skiSwap.delete({ where: { id: swap.id } });
}
await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
