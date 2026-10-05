// Batch add (Plan 40) against a running API and real database: staff scan a
// stack of legacy tickets to one seller, and each becomes that seller's item,
// on sale with no price. A ticket already an item is refused naming whose, and
// nothing is added; a retried Save adds nothing twice. The smoke org has no
// Square, so the push is left to the first real batch.
//
//   SMOKE_BASE=https://patrolkit.io/api/v1 node apps/api/scripts/smoke-batch-tickets.mjs
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
const EMAILS = ['batch-dana@patrolkit.invalid', 'batch-shop@patrolkit.invalid'];

// ─── Fixtures ────────────────────────────────────────────────────────────────
await prisma.swapItem.deleteMany({ where: { orgId: org.id, swap: { title: 'Batch smoke swap' } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Batch smoke swap' } });
for (const email of EMAILS) {
  const u = await prisma.user.findFirst({ where: { email } });
  if (u) await prisma.user.delete({ where: { id: u.id } });
}

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, slug: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title: 'Batch smoke swap',
    squareCategoryId: 'batch-smoke', skuPrefix: 'BTS', active: true, activeSkuPrefix: 'BTS',
    allowLegacyCheckin: true, allowLegacyWeb: false,
  },
});

async function makeSeller(email, firstName, businessName = null) {
  const user = await prisma.user.create({ data: { id: createId(), email, firstName, lastName: 'Smoke' } });
  const membership = await prisma.membership.create({ data: { id: createId(), userId: user.id, orgId: org.id, updatedAt: new Date() } });
  return prisma.sellerProfile.create({ data: { id: createId(), membershipId: membership.id, businessName } });
}
// An individual: batch add takes any seller (D4).
const dana = await makeSeller(EMAILS[0], 'Dana');
const shop = await makeSeller(EMAILS[1], 'Shop', 'Batch Smoke Sports');

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const token = await smokeSession(prisma, BASE, staff, unwrap);
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const ITEMS = `${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`;
const batch = (sellerId, tickets, key) => fetch(`${ITEMS}/batch-tickets`, {
  method: 'POST', headers: { ...H, ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify({ sellerId, tickets }),
});
const check = (sku) => fetch(`${ITEMS}/ticket-check?sku=${encodeURIComponent(sku)}`, { headers: H });

// ─── A stack of 100 for one seller ───────────────────────────────────────────

const hundred = Array.from({ length: 100 }, (_, i) => String(81000 + i * 3));
const key = createId();
const first = await batch(dana.id, hundred, key);
const firstBody = await unwrap(first);
ok('a batch of 100 is added', first.ok && firstBody.created === 100, `${first.status} ${JSON.stringify(firstBody)}`);

const rows = await prisma.swapItem.findMany({ where: { swapId: swap.id, deletedAt: null }, orderBy: { sku: 'asc' } });
ok('...each the seller’s ticket', rows.length === 100 && rows.every((r) => r.sellerId === dana.id), String(rows.length));
ok('...unpriced, named by number, tag already on the goods',
   rows.every((r) => r.priceCents === null && r.name === `Item #${r.sku}` && r.hasPrintedTag && r.categoryId === null),
   JSON.stringify(rows.slice(0, 2).map((r) => [r.sku, r.name, r.priceCents, r.hasPrintedTag])));
ok('...and on sale at once, accepted by whoever saved it',
   rows.every((r) => r.consignedAt !== null && r.consignedBy === staff.id));
ok('...with no print jobs', (await prisma.printJob.count({ where: { itemId: { in: rows.map((r) => r.id) } } })) === 0);

const again = await batch(dana.id, hundred, key);
const againBody = await unwrap(again);
ok('a retried Save with the same key answers the same, adding nothing',
   again.ok && againBody.created === 100
   && (await prisma.swapItem.count({ where: { swapId: swap.id, deletedAt: null } })) === 100,
   `${again.status} ${JSON.stringify(againBody)}`);

// ─── The per-scan check ──────────────────────────────────────────────────────

const free = await unwrap(await check('99999'));
ok('a ticket nobody has is free', free.free === true, JSON.stringify(free));
const taken = await unwrap(await check(hundred[0]));
ok('...and one in the batch says whose', taken.free === false && taken.holder === 'Dana Smoke', JSON.stringify(taken));
const notTicket = await check('BTS-A-0001');
ok('...and one of our tags isn’t a ticket', notTicket.status === 400, String(notTicket.status));

// ─── Refusals ────────────────────────────────────────────────────────────────

const clash = await batch(shop.id, ['99999', hundred[5], hundred[6]]);
const clashBody = await clash.json();
ok('a batch with taken tickets is refused, naming whose',
   clash.status === 409 && clashBody.code === 'TICKET_TAKEN' && /\(Dana Smoke\)/.test(clashBody.error),
   `${clash.status} ${clashBody.error}`);
ok('...listing each, for the popover to mark',
   JSON.stringify(clashBody.details?.taken?.map((t) => t.sku)) === JSON.stringify([hundred[5], hundred[6]]),
   JSON.stringify(clashBody.details));
ok('...and adding nothing', (await prisma.swapItem.count({ where: { swapId: swap.id, sku: '99999' } })) === 0);

const repeat = await batch(shop.id, ['70001', '70001']);
ok('a repeat in the batch is refused', repeat.status === 400, String(repeat.status));
const ourTag = await batch(shop.id, ['BTS-A-0001']);
ok('one of our tags is refused', ourTag.status === 400, String(ourTag.status));

const shopBatch = await unwrap(await batch(shop.id, ['70001', '70002']));
ok('a shop can be batch-added to as well', shopBatch.created === 2, JSON.stringify(shopBatch));

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
for (const email of EMAILS) {
  const u = await prisma.user.findFirst({ where: { email } });
  if (u) await prisma.user.delete({ where: { id: u.id } });
}
await prisma.$disconnect();
console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
