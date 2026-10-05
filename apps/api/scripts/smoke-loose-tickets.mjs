// A loose ticket scanned in at a station, against a running API and real
// database — including the collisions that only the unique index can catch.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-loose-tickets.mjs
//
// Sign-in endpoints are throttled to five attempts a minute, so back-to-back
// runs return 429 and look like a regression. Leave a minute between them.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';

import { smokeOrg, smokeStaff, smokeSession, issueTickets } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const org = await smokeOrg(prisma);

// ─── Fixtures ────────────────────────────────────────────────────────────────
await prisma.printJob.deleteMany({ where: { orgId: org.id } });
await prisma.swapItem.deleteMany({ where: { orgId: org.id, swap: { title: 'Loose ticket smoke' } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Loose ticket smoke' } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'Loose ticket station' } });
for (const email of ['loose-shop@patrolkit.invalid', 'loose-walkin@patrolkit.invalid']) {
  const prior = await prisma.user.findFirst({ where: { email } });
  if (prior) await prisma.user.delete({ where: { id: prior.id } });
}

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, slug: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title: 'Loose ticket smoke', squareCategoryId: 'loose-smoke',
    skuPrefix: 'LSE', active: true, activeSkuPrefix: 'LSE',
    // Off to start: the switch is what the iPad reads, so it gets exercised.
    allowLegacyCheckin: false,
  },
});
const station = await prisma.checkinStation.create({
  data: { id: createId(), orgId: org.id, name: 'Loose ticket station', code: 'L', updatedAt: new Date() },
});

/** A business seller holding a block, and a walk-in holding nothing. */
async function makeSeller(email, first, last, businessName) {
  const user = await prisma.user.create({
    data: { id: createId(), email, firstName: first, lastName: last },
  });
  const membership = await prisma.membership.create({
    data: { id: createId(), userId: user.id, orgId: org.id, updatedAt: new Date() },
  });
  const seller = await prisma.sellerProfile.create({
    data: { id: createId(), membershipId: membership.id, businessName: businessName ?? null },
  });
  return { user, seller };
}

const shop = await makeSeller('loose-shop@patrolkit.invalid', 'Sam', 'Ito', 'Alpine Sports');
const walkin = await makeSeller('loose-walkin@patrolkit.invalid', 'Dana', 'Reyes', null);

// Issued tickets are items from the start (Plan 38).
await issueTickets(prisma, { orgId: org.id, swapId: swap.id, sellerId: shop.seller.id, startNumber: 67000, endNumber: 67499 });

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const token = await smokeSession(prisma, BASE, staff, unwrap);
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const swapUrl = `${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}`;
const itemsUrl = `${swapUrl}/items`;

const scan = (sku, sellerId) =>
  fetch(itemsUrl, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: 'Scanned gear', priceCents: 4500, quantity: 1,
      sku, stationId: station.id, alreadyPrinted: true,
      ...(sellerId ? { sellerId } : {}),
    }),
  });

// ─── The switches (Plan 34) ──────────────────────────────────────────────────

const before = await fetch(swapUrl, { headers: H }).then(unwrap);
ok('a swap reports how staff check-in takes items: print tickets, no legacy ones',
   before.allowLegacyCheckin === false && before.allowPrintCheckin === true,
   `legacy=${before.allowLegacyCheckin} print=${before.allowPrintCheckin}`);

// Square is not configured for the smoke org, and turning this on must not
// need it — the old code asked for a client before reading what had changed.
const turnedOn = await fetch(swapUrl, {
  method: 'PATCH', headers: H, body: JSON.stringify({ allowLegacyCheckin: true }),
});
ok('legacy tickets at check-in can be switched on without Square connected', turnedOn.status === 200, String(turnedOn.status));

const after = await fetch(swapUrl, { headers: H }).then(unwrap);
ok('and the change sticks', after.allowLegacyCheckin === true, String(after.allowLegacyCheckin));

const listed = await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps`, { headers: H }).then(unwrap);
ok('the list the iPad syncs carries it too',
   listed.find((s) => s.id === swap.id)?.allowLegacyCheckin === true,
   String(listed.find((s) => s.id === swap.id)?.allowLegacyCheckin));
ok('and the old field is gone', !('legacyTicketsEnabled' in (listed.find((s) => s.id === swap.id) ?? {})));

// ─── Legacy tickets only, at check-in ────────────────────────────────────────

await fetch(swapUrl, { method: 'PATCH', headers: H, body: JSON.stringify({ allowPrintCheckin: false }) });
const onlyOn = await fetch(swapUrl, { headers: H }).then(unwrap);
ok('print tickets at check-in can be switched off, and that travels with the swap',
   onlyOn.allowPrintCheckin === false && onlyOn.allowLegacyCheckin === true,
   `legacy=${onlyOn.allowLegacyCheckin} print=${onlyOn.allowPrintCheckin}`);

// Check-in must take one or the other.
const neither = await fetch(swapUrl, { method: 'PATCH', headers: H, body: JSON.stringify({ allowLegacyCheckin: false }) });
ok('leaving check-in with neither is refused', neither.status === 400, String(neither.status));

// Print tickets back on for the rest of the run.
await fetch(swapUrl, { method: 'PATCH', headers: H, body: JSON.stringify({ allowPrintCheckin: true }) });
const backOn = await fetch(swapUrl, { headers: H }).then(unwrap);
ok('and check-in can take both', backOn.allowLegacyCheckin === true && backOn.allowPrintCheckin === true,
   `legacy=${backOn.allowLegacyCheckin} print=${backOn.allowPrintCheckin}`);

// ─── A loose ticket ──────────────────────────────────────────────────────────

const loose = await scan('88001', walkin.seller.id).then(unwrap);
ok('a ticket nobody holds is accepted', loose.sku === '88001', loose.sku);
ok('and the number on the tag is the SKU, not a minted one',
   !loose.sku.includes('LSE'), loose.sku);
ok('and nothing was queued to print', loose.hasPrintedTag === true, String(loose.hasPrintedTag));

// ─── A ticket already on something ───────────────────────────────────────────

const again = await scan('88001', walkin.seller.id);
const againBody = await again.json();
ok('re-scanning it is refused, not a 500', again.status === 409, String(again.status));
ok('and says which ticket, and whose', againBody.error === 'Ticket 88001 belongs to Dana Reyes.' && againBody.code === 'TICKET_TAKEN',
   `${againBody.code} ${againBody.error}`);

// ─── A ticket from a shop's block ────────────────────────────────────────────

const stolen = await scan('67169', walkin.seller.id);
const stolenBody = await stolen.json();
ok("a number issued to a shop is refused", stolen.status === 409, String(stolen.status));
ok('and names the shop', stolenBody.error === 'Ticket 67169 belongs to Alpine Sports.' && stolenBody.code === 'TICKET_TAKEN',
   `${stolenBody.code} ${stolenBody.error}`);

// Issued tickets exist from the start: the shop's own is described, not added.
const own = await scan('67169', shop.seller.id);
ok('and so is the shop itself: its ticket is already an item', own.status === 409, String(own.status));

// Just outside the block is nobody's, and must still work.
const nextDoor = await scan('67500', walkin.seller.id);
ok('a number just past the end of a block is free', nextDoor.status === 201 || nextDoor.status === 200,
   String(nextDoor.status));

// ─── Switching it back off ───────────────────────────────────────────────────

await fetch(swapUrl, { method: 'PATCH', headers: H, body: JSON.stringify({ allowLegacyCheckin: false }) });
const off = await fetch(swapUrl, { headers: H }).then(unwrap);
ok('it can be switched off again', off.allowLegacyCheckin === false, String(off.allowLegacyCheckin));

const issuedAfterOff = await prisma.swapItem.count({ where: { swapId: swap.id, sellerId: shop.seller.id, deletedAt: null } });
ok('and tickets already issued are left where they are', issuedAfterOff === 500, String(issuedAfterOff));

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.printJob.deleteMany({ where: { stationId: station.id } });
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.swapSkuCounter.deleteMany({ where: { swapId: swap.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.checkinStation.delete({ where: { id: station.id } });
await prisma.user.delete({ where: { id: shop.user.id } });
await prisma.user.delete({ where: { id: walkin.user.id } });
await prisma.$disconnect();
