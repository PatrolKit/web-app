// Returning unsold items to their sellers (Plan 43), against a running API.
//
// Two ways to run it. Against the stub Square, which also proves what Square
// is told (the item deleted, a sold one refused, a partly sold one's units):
//
//   PAYOUTS_STUB=1 SMOKE_CATALOG_FILE=/tmp/rt-catalog.json SMOKE_INVENTORY_FILE=/tmp/rt-stock.json \
//     PORT=4001 node apps/api/dist/src/main.js &
//   SMOKE_CATALOG_FILE=/tmp/rt-catalog.json SMOKE_INVENTORY_FILE=/tmp/rt-stock.json \
//     node apps/api/scripts/smoke-item-returns.mjs
//
// Or with neither set, against any API: its swap has no Square location, so
// nothing reaches Square, and an item never in Square has nothing sold. That
// is the form for production, in the test org only.
//
// What a unit test can't reach: the routes and their guards (staff and the
// iPad on one, staff alone on the rest), the idempotency key replaying a
// queued iPad return, and the iPad's delta carrying the return so it isn't
// read as a delete.

import fs from 'fs';
import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const CATALOG = process.env.SMOKE_CATALOG_FILE;
const STOCK = process.env.SMOKE_INVENTORY_FILE;
const STUB = !!(CATALOG && STOCK);

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (l, c, e = '') => { if (!c) failures++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`); };

const org = await smokeOrg(prisma);
const TITLE = 'Returns smoke swap';
const EMAILS = ['returns-shop@patrolkit.invalid', 'returns-other@patrolkit.invalid'];
const IPAD = 'Returns smoke iPad';
await prisma.swapItem.deleteMany({ where: { orgId: org.id, swap: { title: TITLE } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: TITLE } });
await prisma.device.deleteMany({ where: { orgId: org.id, name: IPAD } });
for (const email of EMAILS) {
  const old = await prisma.user.findFirst({ where: { email } });
  if (old) await prisma.user.delete({ where: { id: old.id } });
}

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, slug: `rt${Date.now().toString(36)}`, title: TITLE, squareCategoryId: 'rt-cat',
    locationId: STUB ? 'rt-loc' : '', skuPrefix: 'RS', active: true, activeSkuPrefix: 'RS',
  },
});
async function shop(email, name) {
  const u = await prisma.user.create({ data: { id: createId(), email, firstName: 'Returns', lastName: 'Seller' } });
  const m = await prisma.membership.create({ data: { id: createId(), userId: u.id, orgId: org.id, updatedAt: new Date() } });
  return prisma.sellerProfile.create({ data: { id: createId(), membershipId: m.id, businessName: name } });
}
const mine = await shop(EMAILS[0], 'Returns Smoke Sports');
const other = await shop(EMAILS[1], 'Other Smoke Shop');

const accepted = new Date(Date.now() - 3_600_000);
const item = (sku, over = {}) => prisma.swapItem.create({
  data: {
    swapId: swap.id, orgId: org.id, sellerId: mine.id, sku, liveSku: sku, name: 'Returned skis', priceCents: 4500,
    originalQuantity: 1, consignedAt: accepted,
    ...(STUB ? { squareItemId: `sq-${sku}`, squareVariationId: `sv-${sku}` } : {}),
    ...over,
  },
});
const onSale = await item('RS-0001');
const waiting = await item('RS-0002', { consignedAt: null });
const theirs = await item('RS-0003', { sellerId: other.id });
const kept = await item('RS-0004');
const sold = STUB ? await item('RS-0005') : null;
const partly = STUB ? await item('RS-0006', { originalQuantity: 3 }) : null;
if (STUB) {
  const sq = (sku) => ({ itemId: `sq-${sku}`, variationId: `sv-${sku}`, sku, name: 'Returned skis', description: null, pricing: { type: 'fixed', cents: 4500 }, version: '1', updatedAt: null, categoryId: 'rt-cat' });
  fs.writeFileSync(CATALOG, JSON.stringify(['RS-0001', 'RS-0003', 'RS-0004', 'RS-0005', 'RS-0006'].map(sq)));
  fs.writeFileSync(STOCK, JSON.stringify({ 'sv-RS-0001': 1, 'sv-RS-0003': 1, 'sv-RS-0004': 1, 'sv-RS-0005': 0, 'sv-RS-0006': 2 }));
}

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:manage', 'ski_swap:report', 'org:read']);
const token = await smokeSession(prisma, BASE, staff, unwrap);
const ITEMS = `/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`;
const call = (bearer) => (p, init = {}) => fetch(`${BASE}${ITEMS}${p}`, {
  ...init, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
});
const api = call(token);

const secret = createId();
const clientId = createId();
await prisma.device.create({
  data: { id: createId(), orgId: org.id, name: IPAD, role: 'ski_swap.staff_check_in', clientId, secretHash: await argon2.hash(secret, { type: argon2.argon2id }) },
});
const ipadToken = (await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret: secret }),
}).then(unwrap)).accessToken;
const ipad = call(ipadToken);

console.log(`\n── The iPad's return (${STUB ? 'stub Square' : 'no Square'}) ───────────────`);

const before = new Date(Date.now() - 1000).toISOString();
const scannedAt = new Date(Date.now() - 10 * 60_000).toISOString();
const key = `${onSale.id}-return-${scannedAt}`;
const send = () => ipad(`/${onSale.id}/return`, { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify({ returnedAt: scannedAt }) });
const first = await send();
const result = await unwrap(first);
ok('an iPad returns an item', first.status === 200 && result.outcome === 'returned', `HTTP ${first.status} ${result.outcome}`);
ok('...stamped when it was scanned, not when it arrived', result.item?.returnedAt === scannedAt, result.item?.returnedAt);
ok('...by the iPad, by name', result.item?.returnedBy === IPAD, result.item?.returnedBy);
ok('...with its units', result.item?.returnedUnits === 1);
// Checked either way: by Square's count, or never in Square so nothing sold.
ok('...with Square checked', result.squareChecked === true, String(result.squareChecked));

const replay = await unwrap(await send());
ok('the same queued request replays the same answer', replay.outcome === 'returned' && replay.item?.returnedAt === scannedAt);
const again = await unwrap(await ipad(`/${onSale.id}/return`, { method: 'POST', headers: { 'idempotency-key': `${onSale.id}-return-later` }, body: '{}' }));
ok('a second scan is already returned, not an error', again.outcome === 'already_returned', again.outcome);

const walk = await unwrap(await ipad(`?walk=true&updatedSince=${encodeURIComponent(before)}`));
const inWalk = walk.items?.find((i) => i.id === onSale.id);
ok('the iPad’s delta carries the return', inWalk?.returnedAt === scannedAt && inWalk?.deletedAt == null,
  JSON.stringify(inWalk && { returnedAt: inWalk.returnedAt, deletedAt: inWalk.deletedAt }));

const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, action: 'ski_swap.item.returned', targetId: onSale.id } });
ok('...audited once, as the device', audit?.actorType === 'device'
  && (await prisma.auditLog.count({ where: { action: 'ski_swap.item.returned', targetId: onSale.id } })) === 1);

console.log('\n── Refusals ─────────────────────────────────────────');

const refusal = async (r) => ({ status: r.status, body: await r.json() });
const never = await refusal(await api('/return-by-sku', { method: 'POST', body: JSON.stringify({ sku: 'RS-0002' }) }));
ok('never accepted is refused', never.status === 409 && never.body.code === 'NOT_RECEIVED', `${never.status} ${never.body.code}`);
const unknown = await refusal(await api('/return-by-sku', { method: 'POST', body: JSON.stringify({ sku: 'RS-9999' }) }));
ok('an unknown SKU is not found', unknown.status === 404 && unknown.body.code === 'ITEM_NOT_FOUND', `${unknown.status} ${unknown.body.code}`);
const wrong = await refusal(await api('/return-by-sku', { method: 'POST', body: JSON.stringify({ sku: 'RS-0003', sellerId: mine.id }) }));
ok('another seller’s item is refused in a locked session', wrong.status === 409 && wrong.body.code === 'WRONG_SELLER'
  && wrong.body.details?.owner === 'Other Smoke Shop', `${wrong.status} ${wrong.body.code} ${wrong.body.error}`);
const untouched = await prisma.swapItem.findUnique({ where: { id: waiting.id } });
ok('...and none of them was returned', untouched?.returnedAt === null
  && (await prisma.swapItem.findUnique({ where: { id: theirs.id } }))?.returnedAt === null);

if (STUB) {
  const soldR = await refusal(await api('/return-by-sku', { method: 'POST', body: JSON.stringify({ sku: 'RS-0005' }) }));
  ok('one Square says sold is refused', soldR.status === 409 && soldR.body.code === 'ITEM_SOLD', `${soldR.status} ${soldR.body.code}`);
  const part = await unwrap(await api('/return-by-sku', { method: 'POST', body: JSON.stringify({ sku: 'RS-0006' }) }));
  ok('a partly sold one returns its unsold units', part.item?.returnedUnits === 2 && part.item?.soldCount === 1,
    `${part.item?.returnedUnits} returned, ${part.item?.soldCount} sold`);
  const undoPart = await refusal(await api(`/${partly.id}/return`, { method: 'DELETE' }));
  ok('...and can’t be undone', undoPart.status === 409 && undoPart.body.code === 'PARTLY_SOLD', `${undoPart.status} ${undoPart.body.code}`);
  await new Promise((r) => setTimeout(r, 500));
  const left = JSON.parse(fs.readFileSync(CATALOG, 'utf8')).map((r) => r.sku);
  ok('returned items are gone from Square, the rest stay', !left.includes('RS-0001') && !left.includes('RS-0006')
    && left.includes('RS-0004') && left.includes('RS-0005'), left.join(','));
  ok('...keeping their Square ids for past sales', (await prisma.swapItem.findUnique({ where: { id: onSale.id } }))?.squareVariationId === 'sv-RS-0001');
  void sold;
}

console.log('\n── Staff only ───────────────────────────────────────');

const ipadBySku = await ipad('/return-by-sku', { method: 'POST', body: JSON.stringify({ sku: 'RS-0004' }) });
ok('an iPad may not return by SKU', ipadBySku.status === 403, `HTTP ${ipadBySku.status}`);
const ipadList = await ipad(`/unreturned?sellerId=${mine.id}`);
ok('...nor read the still-out list', ipadList.status === 403, `HTTP ${ipadList.status}`);
const ipadUndo = await ipad(`/${onSale.id}/return`, { method: 'DELETE' });
ok('...nor undo', ipadUndo.status === 403, `HTTP ${ipadUndo.status}`);

const out = await unwrap(await api(`/unreturned?sellerId=${mine.id}`));
const outSkus = out.items?.map((i) => i.sku) ?? [];
ok('the still-out list has what’s left', outSkus.includes('RS-0004') && !outSkus.includes('RS-0001') && !outSkus.includes('RS-0002'),
  outSkus.join(','));

const byFilter = await unwrap(await api('?status=returned'));
ok('the Returned filter lists it', byFilter.items?.some((i) => i.id === onSale.id) && !byFilter.items?.some((i) => i.id === kept.id));

const undo = await api(`/${onSale.id}/return`, { method: 'DELETE' });
const undone = await unwrap(undo);
ok('staff undo a return', undo.status === 200 && undone.returnedAt === null, `HTTP ${undo.status}`);
ok('...audited', !!(await prisma.auditLog.findFirst({ where: { action: 'ski_swap.item.return_undone', targetId: onSale.id } })));

// Leave the test org as it was found.
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.device.deleteMany({ where: { orgId: org.id, name: IPAD } });
for (const email of EMAILS) {
  const u = await prisma.user.findFirst({ where: { email } });
  if (u) await prisma.user.delete({ where: { id: u.id } });
}
await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
