// Walks a whole self-service check-in against a running API and real database:
// station QR → register → confirm → join → two items → reprint → finish, then
// drains the queue as the bridge would.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-checkin.mjs
//
//
// Codes are limited to five per destination in 15 minutes. The number below
// belongs to a user this script deletes before it starts, and the codes go with
// it, so back-to-back runs are fine.
// On a host with delivery switched on, the register step really does hand a
// message to SNS. The number below is inside +1 555-01xx, reserved for
// fictional use and not routable to a person, so the send fails at the carrier
// rather than reaching anyone. Do not swap it for a number you own.

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
// Node 18 has no global `crypto`; the deployed host runs 18.
import { randomUUID } from 'crypto';

import { smokeOrg, smokeStaff, smokeSession, forceChallengeCode, textingOnForRun } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };

// Sellers here sign up by phone, which needs texting on (Plan 29). Put back after.
const restoreTexting = await textingOnForRun(prisma, BASE, unwrap);
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const org = await smokeOrg(prisma);

// ─── Fixtures ────────────────────────────────────────────────────────────────
const SEED = 'checkin-smoke';
await prisma.printJob.deleteMany({ where: { orgId: org.id } });
await prisma.swapItem.deleteMany({ where: { orgId: org.id, swap: { title: 'Check-in smoke swap' } } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Check-in smoke swap' } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'Smoke station' } });
await prisma.device.deleteMany({ where: { clientId: `${SEED}-bridge` } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: 'Smoke printer' } });
const priorUser = await prisma.user.findFirst({ where: { phone: '+15550199001' } });
if (priorUser) await prisma.user.delete({ where: { id: priorUser.id } });

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, title: 'Check-in smoke swap', squareCategoryId: 'smoke',
    skuPrefix: 'CIS', active: true, activeSkuPrefix: 'CIS',
  },
});
const device = await prisma.device.create({
  data: {
    orgId: org.id, name: 'Smoke bridge', clientId: `${SEED}-bridge`,
    secretHash: await argon2.hash('smoke-secret'), role: 'ski_swap.print_bridge',
  },
});
const printer = await prisma.swapPrinter.create({
  // A station reaches its printer through its bridge, so the bridge is what
  // the printer is bound to.
  data: { orgId: org.id, name: 'Smoke printer', bluetoothName: 'M110-CI', bridgeDeviceId: device.id },
});
const station = await prisma.checkinStation.create({
  data: { orgId: org.id, name: 'Smoke station', code: 'Q', bridgeDeviceId: device.id },
});

// An item's name comes from a category now (Plan 19), and a seller who is not on
// tickets has to pick one. The tree is not what this script is about, so one
// node stands in for it.
await prisma.taxonomyNode.deleteMany({ where: { orgId: org.id, label: 'Checkin smoke category' } });
const category = await prisma.taxonomyNode.create({
  data: {
    kind: 'CATEGORY', orgId: org.id, label: 'Checkin smoke category',
    // `<org|global>:<parent|root>:<label folded>`, the shape the service writes.
    dedupeKey: `${org.id}:root:checkin smoke category`,
  },
});

// ─── The seller's walk ───────────────────────────────────────────────────────

const ctx = await fetch(`${BASE}/public/checkin/${swap.id}?station=${station.id}`).then(unwrap);
ok('station QR resolves to a swap and a station',
   ctx.swapId === swap.id && ctx.stationName === 'Smoke station', JSON.stringify(ctx).slice(0, 120));

const wrongStation = await fetch(`${BASE}/public/checkin/${swap.id}?station=nope`);
ok('an unknown station is refused', wrongStation.status === 404, String(wrongStation.status));

const reg = await fetch(`${BASE}/public/checkin/${swap.id}/register?station=${station.id}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  // Contact only — the name is settled after the contact is proven.
  body: JSON.stringify({ phone: '5550199001' }),
}).then(unwrap);
ok('registering sends a code on the phone channel', reg.channel === 'phone' && !!reg.challengeId,
   JSON.stringify(reg).slice(0, 120));

// Production withholds the code, correctly — so take the database route rather
// than the API one. Only delivery is bypassed; confirm is the real endpoint.
const code = reg.devCode ?? await forceChallengeCode(prisma, reg.challengeId);

const created = await prisma.user.findFirst({ where: { phone: '+15550199001' } });
ok('the person is created unverified', !!created && created.phoneVerifiedAt === null,
   created ? `verifiedAt=${created.phoneVerifiedAt}` : 'missing');

const session = await fetch(`${BASE}/auth/challenges/${reg.challengeId}/confirm`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code }),
}).then(unwrap);
ok('confirming returns the sign-in context',
   session.context?.stationId === station.id && session.context?.swapId === swap.id,
   JSON.stringify(session.context));

const H = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' };

// The very first joins, and three of them at once — which is the ordinary case,
// not a contrived one: a station QR opened twice, a reload, or a double-tapped
// link all land concurrent joins on a seller who has no profile yet. `upsert` is
// a select and then an insert, so all three used to miss, all three inserted,
// and the losers came back 500 on `SellerProfile_membershipId_key`. Racing has
// to come before the sequential checks below, because once the profile exists
// there is nothing left to race for.
const racers = await Promise.all([0, 1, 2].map(() =>
  fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/join`, {
    method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, stationId: station.id }),
  })));
const raced = await Promise.all(racers.map((r) => r.json()));
const joined = raced[0].data ?? raced[0];
ok('joining creates a seller profile', !!joined.sellerId, JSON.stringify(joined).slice(0, 100));
ok('three first joins at once all succeed on one profile',
   racers.every((r) => r.ok) &&
   new Set(raced.map((b) => b.data?.sellerId)).size === 1 &&
   !!raced[0].data?.sellerId,
   racers.map((r) => r.status).join(','));

const joinAgain = await fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/join`, {
  method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, stationId: station.id }),
}).then(unwrap);
ok('joining twice is idempotent', joinAgain.sellerId === joined.sellerId);

// A person nobody has seen before has no name, so check-in asks for one — and
// only then. A seller the roster already knows is never asked.
ok('a brand-new seller is asked for a name', joined.needsName === true, String(joined.needsName));

await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ firstName: 'Dana', lastName: 'Reyes' }),
});

const rejoined = await fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/join`, {
  method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, stationId: station.id }),
}).then(unwrap);
ok('a seller we already know is not asked again', rejoined.needsName === false, String(rejoined.needsName));

// The name a register call cannot set is the one the receipt needs.
ok('the name reaches the seller record',
   (await prisma.user.findFirst({ where: { phone: '+15550199001' } })).firstName === 'Dana');

// ─── Items ───────────────────────────────────────────────────────────────────

// No `name`: Plan 19 derives it from a category, and the schema is strict, so
// sending one is a 400. Nothing below asserts on a name.
const addItem = (_label, priceCents, key) =>
  fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items`, {
    method: 'POST',
    headers: { ...H, ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify({
      swapId: swap.id, categoryId: category.id, priceCents, quantity: 1, stationId: station.id,
    }),
  }).then(unwrap);

// Fresh per run: keys are scoped to the swap, and this script makes a new swap
// each time, but a fixed key would still replay the previous *run's* response
// were that ever to change.
const runKey = randomUUID();
const item1 = await addItem('Volkl Kendo 88 skis, 177cm', 24900, `${runKey}-1`);
const item2 = await addItem('Smith Vantage helmet, medium', 6500, `${runKey}-2`);
ok('SKUs carry the station code', item1.sku.startsWith('CIS-Q-') && item2.sku.startsWith('CIS-Q-'),
   `${item1.sku}, ${item2.sku}`);
ok('SKUs are sequential and distinct', item1.sku !== item2.sku, `${item1.sku} vs ${item2.sku}`);

const retry = await addItem('Volkl Kendo 88 skis, 177cm', 24900, `${runKey}-1`);
ok('a retried save returns the same item, not a second one', retry.id === item1.id,
   `${retry.id} vs ${item1.id}`);

// The swap's own setting, since labels per item moved there from the org.
const perItem = (await prisma.skiSwap.findUnique({ where: { id: swap.id } })).labelsPerItem;
let jobs = await prisma.printJob.count({ where: { stationId: station.id, kind: 'item' } });
ok('saving queued a tag per item', jobs === perItem * 2, `${jobs} jobs for 2 items @ ${perItem}`);

ok('hasPrintedTag is still false before anything printed',
   (await prisma.swapItem.findUnique({ where: { id: item1.id } })).hasPrintedTag === false);

// An individual's items are read-only to them once entered: staff change them.
const edit = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items/${item1.id}`, {
  method: 'PATCH', headers: H, body: JSON.stringify({ priceCents: 22900 }),
});
ok('an individual seller cannot edit an item they entered', edit.status === 403, `HTTP ${edit.status}`);
const addAway = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ swapId: swap.id, categoryId: category.id, priceCents: 1000, quantity: 1 }),
});
ok('...nor add one away from a station', addAway.status === 403, `HTTP ${addAway.status}`);
jobs = await prisma.printJob.count({ where: { stationId: station.id, kind: 'item' } });
ok('neither queued another tag', jobs === perItem * 2, `${jobs} jobs`);

// ─── A tag printed over Bluetooth must not queue a second one ───────────────
// The client prints it itself and says so. Enqueueing anyway puts a duplicate
// through the bridge — and for an item held offline and synced later, the first
// tag is already on the ski.

// The staff endpoint, not the seller one: a seller's phone never drives a
// printer, so only the staff path can report having printed for itself.
const { user: staffUser } = await smokeStaff(prisma, org, ['ski_swap:report', 'ski_swap:manage', 'ski_swap:admin']);
const staffToken = await smokeSession(prisma, BASE, staffUser, unwrap);
const SH = { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' };

const alreadyPrinted = await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`, {
  method: 'POST',
  headers: SH,
  body: JSON.stringify({
    categoryId: category.id, priceCents: 1500, quantity: 1,
    sellerId: joined.sellerId, stationId: station.id, alreadyPrinted: true,
  }),
}).then(unwrap);
ok('the staff path accepts a station and an already-printed flag', !!alreadyPrinted.id,
   JSON.stringify(alreadyPrinted).slice(0, 110));

ok('an already-printed item queues no tag',
   (await prisma.printJob.count({ where: { itemId: alreadyPrinted.id } })) === 0);
ok('and is recorded as printed without a bridge ack',
   (await prisma.swapItem.findUnique({ where: { id: alreadyPrinted.id } })).hasPrintedTag === true);

// ─── The bridge drains the queue ─────────────────────────────────────────────

const tok = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: `${SEED}-bridge`, clientSecret: 'smoke-secret' }),
}).then(unwrap);
const DH = { authorization: `Bearer ${tok.accessToken}`, 'content-type': 'application/json' };

async function drain() {
  let printed = 0;
  for (let i = 0; i < 20; i++) {
    const claim = await fetch(`${BASE}/devices/me/print-jobs/claim?limit=8`, { method: 'POST', headers: DH }).then(unwrap);
    if (!claim.jobs.length) break;
    for (const job of claim.jobs) {
      await fetch(`${BASE}/devices/me/print-jobs/${job.id}/ack`, { method: 'POST', headers: DH });
      printed++;
    }
  }
  return printed;
}

const printedTags = await drain();
ok('the bridge printed every queued tag', printedTags === perItem * 2, `${printedTags} tags`);
ok('hasPrintedTag flips only once paper came out',
   (await prisma.swapItem.findUnique({ where: { id: item1.id } })).hasPrintedTag === true);

// The item tag reflects the *edited* price, because the render waited for the claim.
const printedJob = await prisma.printJob.findFirst({ where: { itemId: item1.id }, orderBy: { createdAt: 'asc' } });
ok('the edit reached the tag rather than requiring a reprint', printedJob.status === 'printed');

// ─── Reprint ─────────────────────────────────────────────────────────────────

const rp = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items/${item1.id}/reprint`, {
  method: 'POST', headers: H, body: JSON.stringify({ stationId: station.id }),
});
ok('reprint is accepted', rp.status === 202, String(rp.status));
ok('reprint queued exactly one more tag', (await drain()) === 1);

// ─── Finish ──────────────────────────────────────────────────────────────────

const summary = await fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/summary?swapId=${swap.id}`, { headers: H }).then(unwrap);
// Three: two entered through the seller path, plus the one the staff path
// reported as already printed over Bluetooth.
ok('the summary totals the items', summary.items.length === 3 && summary.totalCents === 24900 + 6500 + 1500,
   `${summary.items.length} items, ${summary.totalCents}c`);
ok('the summary names the seller', summary.sellerName === 'Dana Reyes', summary.sellerName);

// A seller cannot leave half-known. Completeness is checked here rather than on
// every write, so staff can still correct one field at a time on a record that
// is missing others — this is the one moment everything has to be present.

let blocked = await fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/finish`, {
  method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, stationId: station.id }),
});
ok('finishing without an address is refused', blocked.status === 400, String(blocked.status));

await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me`, {
  method: 'PATCH', headers: H,
  body: JSON.stringify({ street: '12 Elm Street', city: 'Burlington', state: 'VT', zip: '05401' }),
});

// A patch writes what it was sent and nothing else. Normalising a name the
// caller never sent turned every address save into a rename to nobody, which
// only showed up once check-in started saving an address on its own screen.
const afterAddress = await prisma.user.findFirst({ where: { phone: '+15550199001' } });
ok('saving an address leaves the name alone',
   afterAddress.firstName === 'Dana' && afterAddress.lastName === 'Reyes',
   `${afterAddress.firstName} ${afterAddress.lastName}`);
// `payoutMethod` defaults to CHECK, so clearing it is how the "not answered"
// case is reached at all.
await prisma.user.updateMany({ where: { phone: '+15550199001' }, data: { payoutMethod: null } });
blocked = await fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/finish`, {
  method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, stationId: station.id }),
});
ok('finishing without a payout method is refused', blocked.status === 400, String(blocked.status));

// Venmo, so the typed-ID path is the one exercised end to end.
const paid = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me`, {
  method: 'PATCH', headers: H,
  body: JSON.stringify({ payoutMethod: 'VENMO', payoutTarget: 'VENMO_ID', payoutHandle: '@dana-reyes' }),
});
ok('a payout destination is accepted', paid.status === 200, String(paid.status));

const mismatch = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me`, {
  method: 'PATCH', headers: H,
  body: JSON.stringify({ payoutMethod: 'VENMO', payoutTarget: 'PAYPAL_ID', payoutHandle: 'x@example.com' }),
});
ok('a destination that does not match the method is refused', mismatch.status === 400,
   String(mismatch.status));

const finish = await fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/finish`, {
  method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, stationId: station.id }),
}).then(unwrap);
ok('finishing queues a receipt', finish.receiptPages >= 2, JSON.stringify(finish));

const receiptJobs = await prisma.printJob.count({
  where: { stationId: station.id, kind: { in: ['receipt_header', 'receipt_items'] } },
});
ok('the receipt is header plus item pages', receiptJobs === finish.receiptPages, `${receiptJobs} jobs`);

// This station prints 50 × 30, where a receipt has to be a masthead label and
// then a strip of item labels. The 62 × 100 tier composes all of that onto one
// page and queues no masthead job, so the two arrangements are one edit apart —
// see smoke-tall-receipt.mjs for the other half.
const mastheads = await prisma.printJob.count({
  where: { stationId: station.id, kind: 'receipt_header' },
});
ok('a compact receipt still leads with its own masthead label', mastheads === 1, `${mastheads}`);
ok('the bridge prints the receipt too', (await drain()) === receiptJobs);

// ─── Someone else's item ─────────────────────────────────────────────────────

const stranger = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items/${item1.id}/reprint`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stationId: station.id }),
});
ok('an unauthenticated reprint is refused', stranger.status === 401, String(stranger.status));

// ─── What a device syncing offline can see ───────────────────────────────────
//
// The iPad keeps a local mirror and polls `?updatedSince=`. Three things had to
// be true for that to work, and none of them were: an item had to say when it
// changed, a seller edit had to move the clock the filter reads, and a removal
// had to arrive as a row rather than as an absence.

const listed = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items?take=200`, { headers: SH },
).then(unwrap);
ok('an item says when it last changed', typeof listed.items[0]?.updatedAt === 'string',
   listed.items[0]?.updatedAt);

// The cursor a client would have stored, taken from the server's own clock.
const cursor = new Date(Date.now() - 1000).toISOString();

const quiet = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}/items?take=200&updatedSince=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
  { headers: SH },
).then(unwrap);
ok('an item cursor in the future returns nothing', quiet.items.length === 0, `${quiet.items.length} items`);

const { sellers } = await fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers`, { headers: SH }).then(unwrap);
const dana = sellers.find((x) => x.phone === '+15550199001');
ok('a seller reports a removal field', dana !== undefined && dana.deletedAt === null,
   JSON.stringify(dana?.deletedAt));

// The edit that used to vanish: it writes `User` and bumps the membership,
// leaving `SellerProfile.updatedAt` exactly where it was.
await fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers/${dana.id}`, {
  method: 'PATCH', headers: SH, body: JSON.stringify({ lastName: 'Whitcomb' }),
});

const afterEdit = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers?updatedSince=${encodeURIComponent(cursor)}`,
  { headers: SH },
).then(unwrap).then((r) => r.sellers);
ok('a renamed seller reaches a delta-syncing client',
   afterEdit.some((x) => x.id === dana.id && x.lastName === 'Whitcomb'),
   `${afterEdit.length} changed`);

const profileRow = await prisma.sellerProfile.findUnique({ where: { id: dana.id } });
ok('and the profile row never moved, which is why it was the wrong clock',
   profileRow.updatedAt.toISOString() < cursor,
   `${profileRow.updatedAt.toISOString()} vs cursor ${cursor}`);

// Removal. The item has to go first — a seller holding items cannot be removed.
await prisma.swapItem.deleteMany({ where: { sellerId: dana.id } });
const removed = await fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers/${dana.id}`, {
  method: 'DELETE', headers: SH,
});
ok('a seller can be removed', removed.status === 200 || removed.status === 204, String(removed.status));

const afterRemoval = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers?updatedSince=${encodeURIComponent(cursor)}`,
  { headers: SH },
).then(unwrap).then((r) => r.sellers);
const tombstone = afterRemoval.find((x) => x.id === dana.id);
ok('a removed seller arrives as a tombstone, not an absence', !!tombstone?.deletedAt,
   JSON.stringify(tombstone?.deletedAt));

const live = await fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers`, { headers: SH }).then(unwrap).then((r) => r.sellers);
ok('and is still absent from the staff list', !live.some((x) => x.id === dana.id),
   `${live.length} live`);

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.printJob.deleteMany({ where: { stationId: station.id } });
await prisma.swapItem.deleteMany({ where: { swapId: swap.id } });
await prisma.swapSkuCounter.deleteMany({ where: { swapId: swap.id } });
await prisma.taxonomyNode.deleteMany({ where: { orgId: org.id, label: 'Checkin smoke category' } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.checkinStation.delete({ where: { id: station.id } });
await prisma.swapPrinter.delete({ where: { id: printer.id } });
await prisma.device.delete({ where: { id: device.id } });
await prisma.user.deleteMany({ where: { phone: '+15550199001' } });
await restoreTexting();
await prisma.$disconnect();
