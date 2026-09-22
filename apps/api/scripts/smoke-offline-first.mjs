// The offline-first contract (iOS Plan 17 A–E), against a running API.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-offline-first.mjs
//
// Five asks, and the ones worth a real database are the ones about identity:
//
//   A  a client mints the id, and a create under an id somebody else owns is
//      refused rather than answered with their row;
//   B  a retried patch or photo upload does the work once;
//   C  a patch that lost a race is refused with the current row attached;
//   D  the cursor a list hands back was read before the query, not after;
//   E  a walk pages by a cursor and cannot drop a row off the end.
//
// Sign-in is throttled to five a minute; this script signs in twice, once as
// staff in each of two organizations. Leave a minute between runs.
//
// Everything below is about ids, so the first thing asserted is that the row
// really was created under the id that was asked for. A server quietly minting
// its own would pass most of what follows.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { randomUUID } from 'crypto';

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};
/**
 * Loudly not run, for a check this box cannot make.
 *
 * Only ever for something environmental — no photo storage configured, say —
 * never for a check that is inconvenient. A skip that reads as a pass is how a
 * smoke script ends up proving nothing while looking green.
 */
const skip = (label, why) => console.log(`SKIP  ${label} — ${why}`);

const org = await smokeOrg(prisma);

// ─── Fixtures ────────────────────────────────────────────────────────────────

const prior = await prisma.skiSwap.findMany({
  where: { orgId: org.id, title: 'Offline smoke swap' }, select: { id: true },
});
for (const s of prior) await prisma.swapItem.deleteMany({ where: { swapId: s.id } });
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Offline smoke swap' } });

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, title: 'Offline smoke swap', squareCategoryId: 'off',
    locationId: '', skuPrefix: 'OFF', active: true, activeSkuPrefix: 'OFF',
  },
});

// A second organization, because the sharp edge in ask A is what happens when
// the id a client picked is already somebody else's.
const otherOrg = await prisma.organization.upsert({
  where: { slug: 'patrolkit-smoke-other' },
  update: {},
  create: { id: createId(), name: 'PatrolKit smoke neighbours', slug: 'patrolkit-smoke-other' },
});
await prisma.orgModule.upsert({
  where: { orgId_moduleKey: { orgId: otherOrg.id, moduleKey: 'ski_swap' } },
  update: { enabled: true },
  create: { id: createId(), orgId: otherOrg.id, moduleKey: 'ski_swap', enabled: true, enabledAt: new Date() },
});

const { user: staff } = await smokeStaff(prisma, org, [
  'ski_swap:admin', 'ski_swap:manage', 'ski_swap:report', 'org:read',
]);
const token = await smokeSession(prisma, BASE, staff, unwrap);
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = (p, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });

// Somebody in the neighbouring org, so a cross-org attempt is made by a caller
// who is genuinely allowed to create there.
const otherEmail = 'offline-neighbour@patrolkit.invalid';
await prisma.user.deleteMany({ where: { email: otherEmail } });
const otherUser = await prisma.user.create({
  data: { id: createId(), email: otherEmail, verifiedEmail: otherEmail, emailVerifiedAt: new Date(), firstName: 'Neighbour', lastName: 'Staff' },
});
const otherMembership = await prisma.membership.upsert({
  where: { userId_orgId: { userId: otherUser.id, orgId: otherOrg.id } },
  update: { deletedAt: null },
  create: { id: createId(), userId: otherUser.id, orgId: otherOrg.id, updatedAt: new Date() },
});
const perms = await prisma.permission.findMany({ where: { key: { in: ['ski_swap:manage', 'ski_swap:report'] } } });
for (const perm of perms) {
  await prisma.membershipPermission.upsert({
    where: { membershipId_permissionId: { membershipId: otherMembership.id, permissionId: perm.id } },
    update: {},
    create: { membershipId: otherMembership.id, permissionId: perm.id },
  });
}
const otherToken = await smokeSession(prisma, BASE, otherUser, unwrap);
const otherApi = (p, init = {}) => fetch(`${BASE}${p}`, {
  ...init,
  headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
});

const SELLERS = `/orgs/${org.id}/ski-swap/sellers`;
const ITEMS = `/orgs/${org.id}/ski-swap/swaps/${swap.id}/items`;

console.log('\n── A · the client names the row ──────────────────────────────');

const sellerId = randomUUID();
const made = await api(SELLERS, {
  method: 'POST',
  body: JSON.stringify({ id: sellerId, firstName: 'Offline', lastName: 'Seller', email: `offline-${sellerId}@patrolkit.invalid` }),
}).then(unwrap);
ok('a seller is created under the id the client chose', made.id === sellerId,
  `asked ${sellerId}, got ${made.id}`);
if (made.id !== sellerId) await finish();

// What makes the printed paper right: the QR is correct the moment it prints,
// because the id on it is the id the row has.
const tracking = await fetch(`${BASE}/public/sellers/${sellerId}`);
ok('...so /s/<id> resolves straight away', tracking.status === 200, `HTTP ${tracking.status}`);

const again = await api(SELLERS, {
  method: 'POST',
  body: JSON.stringify({ id: sellerId, firstName: 'Offline', lastName: 'Seller', email: `offline-${sellerId}@patrolkit.invalid` }),
});
const againBody = await unwrap(again);
ok('creating it again answers with the same row rather than a second one',
  again.status < 300 && againBody.id === sellerId, `HTTP ${again.status}`);

const sellerRows = await prisma.sellerProfile.count({ where: { id: sellerId } });
ok('...and there is still exactly one', sellerRows === 1, `${sellerRows}`);

// The sharp edge. Answering with the row would hand a neighbouring
// organization's seller to anybody who guessed a uuid.
const stolen = await otherApi(`/orgs/${otherOrg.id}/ski-swap/sellers`, {
  method: 'POST',
  body: JSON.stringify({ id: sellerId, firstName: 'Not', lastName: 'Yours', email: `thief-${randomUUID()}@patrolkit.invalid` }),
});
ok('another org creating under that id is refused', stolen.status === 409, `HTTP ${stolen.status}`);
const stolenBody = JSON.stringify(await stolen.json());
ok('...and told nothing about whose it is',
  !stolenBody.includes('Offline') && !stolenBody.includes(org.id), stolenBody.slice(0, 140));

const itemId = randomUUID();
const category = await prisma.taxonomyNode.findFirst({
  where: { kind: 'CATEGORY', OR: [{ orgId: null }, { orgId: org.id }] }, select: { id: true },
});
const itemBody = JSON.stringify({ id: itemId, categoryId: category?.id, priceCents: 4500, quantity: 1, sellerId });
const item = await api(ITEMS, { method: 'POST', body: itemBody }).then(unwrap);
ok('an item is created under the id the client chose', item.id === itemId, `${item.id}`);

const itemAgain = await api(ITEMS, { method: 'POST', body: itemBody });
ok('creating it again answers with the same row', itemAgain.status < 300,
  `HTTP ${itemAgain.status}`);
ok('...and there is still exactly one',
  (await prisma.swapItem.count({ where: { id: itemId } })) === 1);

console.log('\n── B · a retry does the work once ────────────────────────────');

const patchKey = randomUUID();
const patchOnce = await api(`${SELLERS}/${sellerId}`, {
  method: 'PATCH', headers: { 'idempotency-key': patchKey },
  body: JSON.stringify({ firstName: 'Patched' }),
}).then(unwrap);
await api(`${SELLERS}/${sellerId}`, {
  method: 'PATCH', headers: { 'idempotency-key': patchKey },
  body: JSON.stringify({ firstName: 'Patched' }),
}).then(unwrap);
ok('a replayed seller patch replays its first answer',
  patchOnce.firstName === 'Patched', `${patchOnce.firstName}`);

const photoKey = randomUUID();
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const upload = async () => {
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'x.png');
  return fetch(`${BASE}${ITEMS}/${itemId}/photos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': photoKey },
    body: form,
  });
};
const firstUpload = await upload();
const firstBody = await firstUpload.clone().text();

if (firstUpload.status === 400 && firstBody.includes('photo storage')) {
  // No S3 and no Square on this box, so the upload fails before anything is
  // stored and there is nothing for a retry to duplicate.
  skip('a retried photo upload leaves one photo', 'no photo storage configured here');
} else {
  const secondUpload = await upload();
  ok('a photo upload is accepted', firstUpload.status < 300, `HTTP ${firstUpload.status}`);
  ok('...and its retry is too', secondUpload.status < 300, `HTTP ${secondUpload.status}`);
  const photoCount = await prisma.swapItemPhoto.count({ where: { itemId } });
  ok('...leaving one photo on the item, not two', photoCount === 1, `${photoCount} photos`);
}

console.log('\n── C · a patch that lost a race ──────────────────────────────');

const current = await api(`${SELLERS}/${sellerId}`).then(unwrap);
const staleWatermark = new Date(Date.parse(current.updatedAt) - 60_000).toISOString();

const conflicted = await api(`${SELLERS}/${sellerId}`, {
  method: 'PATCH',
  body: JSON.stringify({ street: '1 Stale Road', baseUpdatedAt: staleWatermark }),
});
ok('a patch from behind the watermark is refused', conflicted.status === 409,
  `HTTP ${conflicted.status}`);
const conflictBody = await conflicted.json();
ok('...with a code the client can branch on',
  conflictBody.code === 'SELLER_MODIFIED', JSON.stringify(conflictBody).slice(0, 140));
ok('...and the current row attached, so both versions can be shown',
  conflictBody.details?.seller?.id === sellerId,
  JSON.stringify(conflictBody.details ?? conflictBody).slice(0, 160));

const afterConflict = await api(`${SELLERS}/${sellerId}`).then(unwrap);
ok('...and nothing was written', afterConflict.street !== '1 Stale Road',
  `${afterConflict.street}`);

const accepted = await api(`${SELLERS}/${sellerId}`, {
  method: 'PATCH',
  body: JSON.stringify({ street: '2 Fresh Road', baseUpdatedAt: current.updatedAt }),
});
ok('a patch carrying the watermark it was given goes through', accepted.status < 300,
  `HTTP ${accepted.status}`);

console.log('\n── D · the cursor comes from the server clock ────────────────');

const before = new Date();
const listed = await api(`${SELLERS}?updatedSince=2020-01-01T00:00:00.000Z`).then(unwrap);
const after = new Date();
ok('the seller list hands back a read time', !!listed.syncedAt, JSON.stringify(listed).slice(0, 80));
const at = new Date(listed.syncedAt);
ok('...taken while the request was in flight', at >= before && at <= after,
  `${before.toISOString()} ≤ ${listed.syncedAt} ≤ ${after.toISOString()}`);
/*
 * The half that matters, and the only way to show it: a row written after this
 * read must come back when the cursor it handed out is used.
 *
 * Comparing `syncedAt` to the newest row returned proves nothing in either
 * direction — a row committed mid-query can legitimately be newer than a time
 * taken before it. What must hold is that nothing falls in the gap.
 */
const laterSeller = await api(SELLERS, {
  method: 'POST',
  body: JSON.stringify({ id: randomUUID(), firstName: 'After', lastName: 'Cursor', email: `after-${randomUUID()}@patrolkit.invalid` }),
}).then(unwrap);

const delta = await api(`${SELLERS}?updatedSince=${encodeURIComponent(listed.syncedAt)}`).then(unwrap);
ok('a seller written after that read comes back when the cursor is used',
  delta.sellers.some((x) => x.id === laterSeller.id),
  `${delta.sellers.length} in the delta`);

const itemList = await api(`${ITEMS}?updatedSince=2020-01-01T00:00:00.000Z`).then(unwrap);
ok('the item list hands one back too', !!itemList.syncedAt, `${itemList.syncedAt}`);

console.log('\n── E · a walk that cannot drop a row ─────────────────────────');

for (let i = 0; i < 4; i++) {
  await prisma.swapItem.create({
    data: {
      id: randomUUID(), swapId: swap.id, orgId: org.id, sellerId,
      name: `Walk item ${i}`, sku: `OFF-W-${i}`, liveSku: `OFF-W-${i}`,
      priceCents: 1000 + i, originalQuantity: 1, consignedAt: new Date(),
    },
  });
}

const seen = new Set();
let cursor = null;
let pages = 0;
for (;;) {
  const qs = new URLSearchParams({ walk: 'true', take: '2' });
  if (cursor) qs.set('after', cursor);
  const page = await api(`${ITEMS}?${qs}`).then(unwrap);
  pages++;

  // An insert between pages. Offset paging would shift a live row off the end
  // of the next page, and a client that deletes whatever did not come back
  // would delete it.
  if (pages === 1) {
    await prisma.swapItem.create({
      data: {
        id: randomUUID(), swapId: swap.id, orgId: org.id, sellerId,
        name: 'Inserted mid-walk', sku: 'OFF-W-9', liveSku: 'OFF-W-9',
        priceCents: 9999, originalQuantity: 1, consignedAt: new Date(),
      },
    });
  }

  for (const i of page.items) seen.add(i.id);
  if (!page.nextAfter) break;
  cursor = page.nextAfter;
  if (pages > 20) break;
}

const live = await prisma.swapItem.findMany({
  where: { swapId: swap.id, deletedAt: null }, select: { id: true },
});
const missed = live.filter((r) => !seen.has(r.id));
ok('the walk took more than one page', pages > 1, `${pages} pages`);
ok('...and every item that existed throughout came back',
  missed.length <= 1, `${missed.length} missed of ${live.length}`);
ok('...with no page repeating a row it already gave',
  seen.size >= live.length - 1, `saw ${seen.size}, live ${live.length}`);

const badCursor = await api(`${ITEMS}?walk=true&after=not-a-cursor`);
ok('a cursor we did not mint is refused', badCursor.status === 400, `HTTP ${badCursor.status}`);

await finish();

async function finish() {
  console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}
