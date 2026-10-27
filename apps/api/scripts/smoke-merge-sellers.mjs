// Plan 57: merging two sellers who are one seller, against a running API and
// real database. A person and a business record of the same seller are merged:
// every item, receipt and payout line goes where the plan says, the retired id
// still lands writes and its public page, and money already moved refuses.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-merge-sellers.mjs
//
// Sign-in endpoints are throttled to five attempts a minute, so back-to-back
// runs return 429 and look like a regression. Leave a minute between them.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const TITLE = 'Merge smoke swap';
const PHONES = ['+15550198301', '+15550198302', '+15550198303'];
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
let failed = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

const org = await smokeOrg(prisma);

// ─── Fixtures ────────────────────────────────────────────────────────────────

async function cleanUp() {
  for (const s of await prisma.skiSwap.findMany({ where: { orgId: org.id, title: TITLE }, select: { id: true } })) {
    await prisma.payoutRun.deleteMany({ where: { swapId: s.id } });
    await prisma.swapItem.deleteMany({ where: { swapId: s.id } });
    await prisma.skiSwap.delete({ where: { id: s.id } });
  }
  const users = await prisma.user.findMany({ where: { OR: [{ phone: { in: PHONES } }, { lastName: 'MergeSmoke' }] }, select: { id: true } });
  await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
}
await cleanUp();

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, slug: `m${Date.now().toString(36)}`, title: TITLE, squareCategoryId: 'merge',
    locationId: 'stub-location', skuPrefix: 'MRG', active: true, activeSkuPrefix: 'MRG', sellerLookupEnabled: true,
  },
});

async function seller({ first, last, phone, verified, business, payout, address }) {
  const user = await prisma.user.create({
    data: {
      id: createId(), firstName: first, lastName: last,
      ...(phone ? { phone, ...(verified ? { verifiedPhone: phone, phoneVerifiedAt: new Date() } : {}) } : {}),
      ...(address ? { street: '7 Mountain Rd', city: 'Stowe', state: 'VT', zip: '05672' } : {}),
      ...payout,
    },
  });
  const membership = await prisma.membership.create({ data: { id: createId(), userId: user.id, orgId: org.id, updatedAt: new Date() } });
  const profile = await prisma.sellerProfile.create({ data: { id: createId(), membershipId: membership.id, businessName: business ?? null } });
  return { id: profile.id, userId: user.id, membershipId: membership.id };
}

// The person: verified phone, paid by scanned Venmo, no address.
const keep = await seller({
  first: 'Tom', last: 'MergeSmoke', phone: PHONES[0], verified: true,
  payout: { payoutMethod: 'VENMO', payoutTarget: 'VENMO_ID', payoutHandle: 'tom-merge-smoke', payoutHandleScannedAt: new Date() },
});
// The same seller entered again as a business: no contacts, a check, an address.
const other = await seller({ first: null, last: null, business: 'Tom MergeSmoke Co', payout: { payoutMethod: 'CHECK' }, address: true });
// Someone already paid, to refuse.
const paid = await seller({ first: 'Paid', last: 'MergeSmoke', phone: PHONES[2], verified: true, payout: { payoutMethod: 'CHECK' }, address: true });

let n = 0;
const item = (sellerId, extra = {}) => prisma.swapItem.create({
  data: { id: createId(), swapId: swap.id, orgId: org.id, sellerId, name: `Merge smoke ${++n}`, sku: `MRG-${String(n).padStart(4, '0')}`, priceCents: 1000, originalQuantity: 1, ...extra },
});
await item(keep.id); await item(keep.id);
await item(other.id); await item(other.id); await item(other.id);
await item(other.id, { deletedAt: new Date() });
await item(paid.id);

await prisma.receipt.create({
  data: { id: createId(), orgId: org.id, swapId: swap.id, sellerId: other.id, token: createId().slice(0, 24), orgName: 'Smoke', swapTitle: TITLE, sellerName: 'Tom MergeSmoke Co', totalCents: 3000, itemCount: 3 },
});

const run = (kind, status) => prisma.payoutRun.create({ data: { id: createId(), orgId: org.id, swapId: swap.id, kind, status } });
const checkRun = await run('CHECK', 'OPEN');
const paypalRun = await run('PAYPAL', 'OPEN');
const oldRun = await run('PAYPAL', 'CLOSED');
const line = (runId, s, status, extra = {}) => prisma.payoutLine.create({
  data: { id: createId(), runId, swapId: swap.id, sellerId: s.id, sellerName: 'x', status, ...extra },
});
const otherPending = await line(checkRun.id, other, 'PENDING', { activeKey: `${swap.id}:${other.id}` });
const keepApproved = await line(paypalRun.id, keep, 'APPROVED', { approvedNetCents: 1600, approvedAt: new Date(), approvedBy: 'smoke', activeKey: `${swap.id}:${keep.id}` });
const otherFailed = await line(oldRun.id, other, 'FAILED', { frozenAt: new Date(), netCents: 800 });
await line(oldRun.id, paid, 'SENT', { frozenAt: new Date(), netCents: 800 });

const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:report', 'ski_swap:manage', 'ski_swap:admin']);
const token = await smokeSession(prisma, BASE, staff, unwrap);
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = (path, init = {}) => fetch(`${BASE}/orgs/${org.id}/ski-swap${path}`, { headers: H, ...init });

// ─── Preview ─────────────────────────────────────────────────────────────────

const preview = await api(`/sellers/${keep.id}/merge-preview?other=${other.id}`).then(unwrap);
ok('the preview counts every item that moves, removed ones too', preview.moves?.items === 4, JSON.stringify(preview.moves));
ok('...and the receipt', preview.moves?.receipts === 1);
const effect = (id) => preview.payoutLines?.find((l) => l.lineId === id)?.effect;
ok('the other seller’s pending check-run line is removed', effect(otherPending.id) === 'removed', effect(otherPending.id));
ok('the kept seller’s approved line goes back to review', effect(keepApproved.id) === 'unapproved', effect(keepApproved.id));
ok('a failed payment stays as history', effect(otherFailed.id) === 'history', effect(otherFailed.id));
ok('the person with a verified phone is suggested to keep', preview.suggestedKeepId === keep.id);
ok('the check and address can be taken', preview.choices?.payout?.offered === true && preview.choices?.address?.offered === true, JSON.stringify(preview.choices));
ok('nothing refuses it', preview.refusals?.length === 0, JSON.stringify(preview.refusals));

// ─── Refusals ────────────────────────────────────────────────────────────────

const choices = { address: 'other', payout: 'keep', businessName: 'none' };
const stale = await api(`/sellers/${keep.id}/merge`, { method: 'POST', body: JSON.stringify({ otherSellerId: other.id, choices, expected: { items: 3, payoutLines: preview.expected.payoutLines } }) });
ok('a merge on stale counts is refused', stale.status === 409, String(stale.status));

const paidPreview = await api(`/sellers/${keep.id}/merge-preview?other=${paid.id}`).then(unwrap);
ok('a seller already paid can’t be merged away', paidPreview.refusals?.length === 1, JSON.stringify(paidPreview.refusals));
const paidMerge = await api(`/sellers/${keep.id}/merge`, { method: 'POST', body: JSON.stringify({ otherSellerId: paid.id, choices, expected: paidPreview.expected }) });
ok('...and the merge says so', paidMerge.status === 409, String(paidMerge.status));

const self = await api(`/sellers/${keep.id}/merge-preview?other=${keep.id}`);
ok('a seller can’t be merged into themselves', self.status === 400, String(self.status));

// ─── The merge ───────────────────────────────────────────────────────────────

const before = new Date(Date.now() - 1000).toISOString();
const result = await api(`/sellers/${keep.id}/merge`, { method: 'POST', body: JSON.stringify({ otherSellerId: other.id, choices, expected: preview.expected }) }).then(unwrap);
ok('the merge reports what moved', result.moved?.items === 4 && result.moved?.receipts === 1 && result.linesRemoved === 1 && result.linesUnapproved === 1, JSON.stringify(result));

const items = await prisma.swapItem.findMany({ where: { swapId: swap.id, sellerId: { in: [keep.id, other.id] } } });
ok('every item is the kept seller’s', items.length === 6 && items.every((i) => i.sellerId === keep.id), String(items.length));
ok('so is the receipt', (await prisma.receipt.count({ where: { sellerId: keep.id } })) === 1);
const retired = await prisma.sellerProfile.findUnique({ where: { id: other.id } });
ok('the other seller is retired and points at the kept one', !!retired.deletedAt && retired.mergedIntoId === keep.id && retired.mergedBy === staff.id);
ok('their pending check-run line is gone', !(await prisma.payoutLine.findUnique({ where: { id: otherPending.id } })));
ok('their failed payment stays with them', (await prisma.payoutLine.findUnique({ where: { id: otherFailed.id } }))?.sellerId === other.id);
const reviewed = await prisma.payoutLine.findUnique({ where: { id: keepApproved.id } });
ok('the kept seller’s line needs review again', reviewed.status === 'PENDING' && reviewed.approvedNetCents === null, reviewed.status);
const keptUser = await prisma.user.findUnique({ where: { id: keep.userId } });
ok('the kept seller took the address, and kept their Venmo', keptUser.street === '7 Mountain Rd' && keptUser.payoutMethod === 'VENMO' && !!keptUser.payoutHandleScannedAt);
const audit = await prisma.auditLog.findFirst({ where: { orgId: org.id, action: 'ski_swap.seller.merged', targetId: keep.id }, orderBy: { createdAt: 'desc' } });
ok('one audit row lists the items moved', audit?.metadata?.itemIds?.length === 4, String(audit?.metadata?.itemIds?.length));

// ─── After ───────────────────────────────────────────────────────────────────

const delta = await api(`/sellers?updatedSince=${encodeURIComponent(before)}`).then(unwrap);
const tomb = (delta.sellers ?? delta).find?.((s) => s.id === other.id);
ok('the iPads’ seller delta carries the tombstone', !!tomb?.deletedAt, JSON.stringify(tomb && { id: tomb.id, deletedAt: tomb.deletedAt }));
const list = await api('/sellers').then(unwrap);
ok('the Sellers list no longer shows them', !(list.sellers ?? list).some?.((s) => s.id === other.id));

const anItem = await prisma.swapItem.findFirst({ where: { swapId: swap.id, sellerId: keep.id, deletedAt: null } });
const patched = await api(`/swaps/${swap.id}/items/${anItem.id}`, { method: 'PATCH', body: JSON.stringify({ sellerId: other.id }) });
const patchedRow = await prisma.swapItem.findUnique({ where: { id: anItem.id } });
ok('a write naming the retired seller lands on the kept one', patched.status === 200 && patchedRow.sellerId === keep.id, `${patched.status} ${patchedRow.sellerId}`);

// The public page names the seller rather than carrying an id.
const publicPage = await fetch(`${BASE}/public/sellers/${other.id}`).then(unwrap);
ok('a link to the retired seller shows the kept one', publicPage.available === true && publicPage.sellerName === 'Tom MergeSmoke', JSON.stringify(publicPage).slice(0, 120));

const again = await api(`/sellers/${keep.id}/merge-preview?other=${other.id}`);
ok('a merged seller can’t be merged again', again.status === 409, String(again.status));

await cleanUp();
await prisma.$disconnect();
console.log(failed ? `\n${failed} assertion(s) failed` : '\nAll assertions passed');
process.exit(failed ? 1 : 0);
