// Plan 33 against a running API and real database, in the smoke org only: a
// swap's slug, the public SKU lookup, the seller status pages each swap decides
// on, who may sign in, and check-in-only sessions.
//
// The smoke org has no Square, so the swap is created in the database and the
// API does everything else; creating and renaming one are covered by unit tests.
//
//   SMOKE_BASE=https://patrolkit.io/api/v1 node apps/api/scripts/smoke-swap-status.mjs

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { createHash } from 'crypto';
import { smokeOrg, smokeStaff, smokeSession, SMOKE_CODE } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
let failed = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

const TITLE = 'Status page smoke swap';
const OTHER = 'Status page smoke swap B';
const EMAILS = {
  seller: 'status-seller@patrolkit.invalid',
  shop: 'status-shop@patrolkit.invalid',
  member: 'status-member@patrolkit.invalid',
};

const org = await smokeOrg(prisma);
async function tidy() {
  await prisma.swapItem.deleteMany({ where: { orgId: org.id, swap: { title: { in: [TITLE, OTHER] } } } });
  await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: { in: [TITLE, OTHER] } } });
  await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'Status smoke station' } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
}
await tidy();

const swap = await prisma.skiSwap.create({
  data: { orgId: org.id, title: TITLE, squareCategoryId: 'status-smoke', skuPrefix: 'SPS', slug: 'status-smoke', active: true, activeSkuPrefix: 'SPS' },
});
const other = await prisma.skiSwap.create({
  data: { orgId: org.id, title: OTHER, squareCategoryId: 'status-smoke-b', skuPrefix: 'SPSB', slug: 'status-smoke-b', active: true, activeSkuPrefix: 'SPSB', skuLookupEnabled: true },
});

async function person(email, businessName, opts = {}) {
  const user = await prisma.user.create({ data: { id: createId(), email, firstName: 'Status', lastName: 'Smoke', phone: opts.phone ?? null } });
  const membership = await prisma.membership.create({ data: { id: createId(), userId: user.id, orgId: org.id, updatedAt: new Date() } });
  const seller = opts.member ? null : await prisma.sellerProfile.create({ data: { id: createId(), membershipId: membership.id, businessName } });
  return { user, seller };
}
const individual = await person(EMAILS.seller, null, { phone: '+15550190142' });
const shop = await person(EMAILS.shop, 'Status Smoke Sports');
const member = await person(EMAILS.member, null, { member: true });

const item = (sku, extra = {}) => prisma.swapItem.create({
  data: { id: createId(), swapId: swap.id, orgId: org.id, sellerId: individual.seller.id, name: `Smoke item ${sku}`,
    sku, liveSku: sku, priceCents: 4500, originalQuantity: 1, consignedAt: new Date(), ...extra },
});
await item('91001');
await item('91002', { consignedAt: null });
await prisma.swapItem.create({
  data: { id: createId(), swapId: other.id, orgId: org.id, name: 'Other swap item', sku: '91003', liveSku: '91003', priceCents: 1000, originalQuantity: 1, consignedAt: new Date() },
});

const { user: staffUser } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const SH = { authorization: `Bearer ${await smokeSession(prisma, BASE, staffUser, unwrap)}`, 'content-type': 'application/json' };
const swapUrl = `${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}`;
const patch = (body) => fetch(swapUrl, { method: 'PATCH', headers: SH, body: JSON.stringify(body) });

// ─── Slug ────────────────────────────────────────────────────────────────────

const listed = (await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps`, { headers: SH }).then(unwrap)).find((s) => s.id === swap.id);
ok('a swap reports its slug, with every switch off', listed?.slug === 'status-smoke' &&
  !listed.skuLookupEnabled && !listed.sellerLookupEnabled && !listed.sellerLoginEnabled, JSON.stringify(listed && { slug: listed.slug }));
const clash = await patch({ slug: 'status-smoke-b' });
ok('another swap’s slug is refused', clash.status === 409, `HTTP ${clash.status}`);
const renamed = await patch({ slug: 'status-smoke-2' });
ok('a slug can be changed', renamed.ok && (await unwrap(renamed)).slug === 'status-smoke-2', `HTTP ${renamed.status}`);
const bad = await patch({ slug: 'Not A Slug!' });
ok('a slug that isn’t one is refused', bad.status === 400, `HTTP ${bad.status}`);

// ─── SKU Lookup ──────────────────────────────────────────────────────────────

const orgSlug = (await prisma.organization.findUnique({ where: { id: org.id }, select: { slug: true } })).slug;
const lookup = (swapSlug, sku) => fetch(`${BASE}/public/${orgSlug}/swaps/${swapSlug}${sku !== undefined ? `/sku/${sku}` : ''}`);

ok('off, the lookup page is a 404', (await lookup('status-smoke-2')).status === 404);
ok('off, a SKU is a 404', (await lookup('status-smoke-2', '91001')).status === 404);
await patch({ skuLookupEnabled: true });
const pageRes = await lookup('status-smoke-2').then(unwrap);
ok('on, the page has the swap’s title', pageRes.swapTitle === TITLE, JSON.stringify(pageRes));
const found = await lookup('status-smoke-2', '91001').then(unwrap);
ok('on, a SKU shows its name and status, and nothing else',
  JSON.stringify(Object.keys(found).sort()) === JSON.stringify(['name', 'sku', 'status']) && found.name === 'Smoke item 91001',
  JSON.stringify(found));
ok('...unknown while Square can’t say (no Square here)', found.status === 'unknown', found.status);
ok('an item not yet checked in says so', (await lookup('status-smoke-2', '91002').then(unwrap)).status === 'not_received');
ok('another swap’s SKU is a 404', (await lookup('status-smoke-2', '91003')).status === 404);
ok('an unknown SKU is a 404', (await lookup('status-smoke-2', '99999')).status === 404);

// ─── Unauthenticated Seller Status ───────────────────────────────────────────

const find = () => fetch(`${BASE}/public/${orgSlug}/ski-swap/seller-find?email=${encodeURIComponent(EMAILS.seller)}&last4=0142`);
const sPage = () => fetch(`${BASE}/public/sellers/${individual.seller.id}`).then(unwrap);
ok('off, the email and last-4 lookup finds nobody', (await find()).status === 404);
const closedPage = await sPage();
ok('off, /s/ shows nothing, not even the name', closedPage.available === false && closedPage.sellerName === null && closedPage.swaps.length === 0,
  JSON.stringify({ available: closedPage.available, sellerName: closedPage.sellerName }));
await patch({ sellerLookupEnabled: true });
const foundSeller = await find().then(unwrap);
ok('on, the lookup finds the seller', foundSeller.sellerId === individual.seller.id, JSON.stringify(foundSeller));
const openPage = await sPage();
ok('on, /s/ shows their items in that swap', openPage.available === true && openPage.swaps.some((s) => s.swapId === swap.id),
  JSON.stringify({ available: openPage.available, swaps: openPage.swaps?.length }));

// ─── Who may sign in ─────────────────────────────────────────────────────────

const requestLink = async (email) => {
  await prisma.contactChallenge.deleteMany({ where: { target: email } });
  const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) }).then(unwrap);
  const stored = await prisma.contactChallenge.findUnique({ where: { id: res.challengeId ?? '' } });
  return { answered: !!res.challengeId, sent: !!stored };
};
const refused = await requestLink(EMAILS.seller);
ok('off, an individual seller gets the usual answer and no link', refused.answered && !refused.sent, JSON.stringify(refused));
const shopLink = await requestLink(EMAILS.shop);
ok('a shop is always sent a link', shopLink.sent, JSON.stringify(shopLink));
const memberLink = await requestLink(EMAILS.member);
ok('a plainly invited member is sent a link', memberLink.sent, JSON.stringify(memberLink));
await patch({ sellerLoginEnabled: true });
const allowed = await requestLink(EMAILS.seller);
ok('on, the individual seller is sent a link', allowed.sent, JSON.stringify(allowed));

// The policy is checked again when a link is opened: one sent while open,
// opened after it closed, signs nobody in.
const lateLink = await prisma.contactChallenge.create({
  data: { id: createId(), userId: individual.user.id, channel: 'email', target: EMAILS.seller, purpose: 'login',
    codeHash: createHash('sha256').update(SMOKE_CODE).digest('hex'), expiresAt: new Date(Date.now() + 600_000) },
});
await patch({ sellerLoginEnabled: false });
const late = await fetch(`${BASE}/auth/challenges/${lateLink.id}/confirm`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: SMOKE_CODE }),
});
const lateBody = await late.json();
ok('a link opened after sign-in closed is refused', late.status === 403 && lateBody.code === 'SIGN_IN_CLOSED', `HTTP ${late.status} ${lateBody.code}`);

// ─── A check-in session ──────────────────────────────────────────────────────

const station = await prisma.checkinStation.create({ data: { id: createId(), orgId: org.id, name: 'Status smoke station', code: 'Q' } }).catch(async () =>
  prisma.checkinStation.create({ data: { id: createId(), orgId: org.id, name: 'Status smoke station', code: 'W' } }));
const atStation = await prisma.contactChallenge.create({
  data: { id: createId(), userId: individual.user.id, channel: 'email', target: EMAILS.seller, purpose: 'login',
    codeHash: createHash('sha256').update(SMOKE_CODE).digest('hex'), expiresAt: new Date(Date.now() + 600_000),
    context: { swapId: swap.id, stationId: station.id } },
});
const checkin = await fetch(`${BASE}/auth/challenges/${atStation.id}/confirm`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: SMOKE_CODE }),
});
const checkinSession = await unwrap(checkin);
ok('signing in at a station works with everything off', checkin.ok && !!checkinSession.accessToken, `HTTP ${checkin.status}`);
const CH = { authorization: `Bearer ${checkinSession.accessToken}` };
const me = await fetch(`${BASE}/me`, { headers: CH }).then(unwrap);
ok('...as a check-in session', me.sessionScope === 'checkin', me.sessionScope);
const dashboard = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items?swapId=${swap.id}`, { headers: CH });
const dashboardBody = await dashboard.json();
ok('...which a dashboard route refuses', dashboard.status === 403 && dashboardBody.code === 'CHECKIN_SESSION', `HTTP ${dashboard.status} ${dashboardBody.code}`);
const profile = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me`, { headers: CH });
ok('...and a check-in route lets in', profile.ok, `HTTP ${profile.status}`);
const refreshRow = await prisma.refreshToken.findFirst({ where: { userId: individual.user.id }, orderBy: { createdAt: 'desc' } });
const hours = (refreshRow.expiresAt.getTime() - Date.now()) / 3_600_000;
ok('...that lasts a day', refreshRow.scope === 'checkin' && hours > 23 && hours <= 24, `${refreshRow.scope}, ${hours.toFixed(1)}h`);

// ─── The SKU lookup's own limit ──────────────────────────────────────────────

let limited = false;
for (let i = 0; i < 35 && !limited; i++) limited = (await lookup('status-smoke-2', '91001')).status === 429;
ok('the SKU lookup is rate-limited', limited);

await prisma.checkinStation.delete({ where: { id: station.id } });
await tidy();
console.log(failed ? `${failed} failed` : 'All assertions passed');
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
