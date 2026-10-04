// Plan 36 against a running API and real database, in the smoke org only: a
// swap's receipt settings, what they refuse, the layout a receipt carries, its
// fine print, signing in from a receipt, and a swap that gives no receipts.
//
// The smoke org has no Square, so the swap is created in the database and the
// API does everything else.
//
//   SMOKE_BASE=https://patrolkit.io/api/v1 node apps/api/scripts/smoke-receipt-settings.mjs

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

const TITLE = 'Receipt settings smoke swap';
const EMAILS = {
  verified: 'receipt-settings-verified@patrolkit.invalid',
  unverified: 'receipt-settings-unverified@patrolkit.invalid',
};

const org = await smokeOrg(prisma);
async function tidy() {
  const swaps = await prisma.skiSwap.findMany({ where: { orgId: org.id, title: TITLE }, select: { id: true } });
  for (const s of swaps) {
    await prisma.receipt.deleteMany({ where: { swapId: s.id } });
    await prisma.swapItem.deleteMany({ where: { swapId: s.id } });
  }
  await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: TITLE } });
  for (const email of Object.values(EMAILS)) {
    await prisma.contactChallenge.deleteMany({ where: { target: email } });
  }
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
}
await tidy();

const swap = await prisma.skiSwap.create({
  data: { orgId: org.id, title: TITLE, squareCategoryId: 'receipt-settings-smoke', skuPrefix: 'RSS',
    slug: `rss${Date.now().toString(36)}`, active: true, activeSkuPrefix: 'RSS' },
});

async function seller(email, verified) {
  const user = await prisma.user.create({
    data: { id: createId(), email, firstName: 'Receipt', lastName: 'Settings', verifiedEmail: verified ? email : null },
  });
  const membership = await prisma.membership.create({ data: { id: createId(), userId: user.id, orgId: org.id, updatedAt: new Date() } });
  const profile = await prisma.sellerProfile.create({ data: { id: createId(), membershipId: membership.id } });
  await prisma.swapItem.create({
    data: { id: createId(), swapId: swap.id, orgId: org.id, sellerId: profile.id, name: "Smoke skis",
      sku: `RSS-${profile.id.slice(0, 6)}`, liveSku: `RSS-${profile.id.slice(0, 6)}`, priceCents: 12500, originalQuantity: 1, consignedAt: new Date() },
  });
  return { user, profile };
}
const verified = await seller(EMAILS.verified, true);
const unverified = await seller(EMAILS.unverified, false);

const { user: staffUser } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const SH = { authorization: `Bearer ${await smokeSession(prisma, BASE, staffUser, unwrap)}`, 'content-type': 'application/json' };
const patch = (body) => fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps/${swap.id}`, { method: 'PATCH', headers: SH, body: JSON.stringify(body) });
const mint = (who) => fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers/${who.profile.id}/receipts`, {
  method: 'POST', headers: SH, body: JSON.stringify({ swapId: swap.id }),
});
const publicReceipt = (token) => fetch(`${BASE}/public/receipts/${token}`);

// ─── Settings ────────────────────────────────────────────────────────────────

const listed = (await fetch(`${BASE}/orgs/${org.id}/ski-swap/swaps`, { headers: SH }).then(unwrap)).find((s) => s.id === swap.id);
ok('a swap starts itemized, every column, no link, printing on 62 × 100, no fine print',
  listed?.receiptMode === 'ITEMIZED' && listed.receiptShowSku && listed.receiptShowName && listed.receiptShowPrice &&
  listed.receiptLink === 'NONE' && listed.receiptPrintEnabled && listed.receiptPaperSize === '62x100' &&
  !listed.receiptFinePrintEnabled && listed.receiptFinePrint === null, JSON.stringify(listed && { mode: listed.receiptMode, link: listed.receiptLink }));

ok('a swap starts in Eastern time', listed?.timeZone === 'America/New_York', listed?.timeZone);
const badZone = await patch({ timeZone: 'Mars/Olympus' });
ok('a zone that isn’t one is refused', badZone.status === 400, `HTTP ${badZone.status}`);
const denver = await patch({ timeZone: 'America/Denver' });
ok('a real zone saves', denver.ok && (await unwrap(denver)).timeZone === 'America/Denver', `HTTP ${denver.status}`);

const statusNoLink = await patch({ receiptMode: 'STATUS_ONLY' });
ok('status page only with no link is refused', statusNoLink.status === 400, `HTTP ${statusNoLink.status}`);
const namesNothing = await patch({ receiptShowSku: false, receiptShowName: false });
ok('an itemized receipt naming nothing is refused', namesNothing.status === 400, `HTTP ${namesNothing.status}`);
const emptyFine = await patch({ receiptFinePrintEnabled: true, receiptFinePrint: '<p> </p>' });
ok('fine print turned on with nothing in it is refused', emptyFine.status === 400, `HTTP ${emptyFine.status}`);
const longFine = await patch({ receiptFinePrintEnabled: true, receiptFinePrint: `<p>${'x'.repeat(2001)}</p>` });
ok('fine print over 2,000 characters is refused', longFine.status === 400, `HTTP ${longFine.status}`);
const badPaper = await patch({ receiptPaperSize: '25x67' });
ok('helper-label paper is refused for receipts', badPaper.status === 400, `HTTP ${badPaper.status}`);

const saved = await patch({
  receiptShowPrice: false,
  receiptLink: 'SELLER_STATUS',
  sellerLookupEnabled: true,
  receiptFinePrintEnabled: true,
  receiptFinePrint: '<p><b>All sales final.</b><script>alert(1)</script> <a href="javascript:alert(1)">x</a> <a href="https://example.com" onclick="x()">Rules</a></p>',
});
const savedBody = await unwrap(saved);
ok('price off, a link and fine print save', saved.ok && savedBody.receiptShowPrice === false && savedBody.receiptLink === 'SELLER_STATUS',
  `HTTP ${saved.status}`);
ok('...and the fine print is sanitized on the way in',
  savedBody.receiptFinePrint === '<p><strong>All sales final.</strong> <a>x</a> <a href="https://example.com">Rules</a></p>',
  savedBody.receiptFinePrint);

// ─── The layout a receipt carries ────────────────────────────────────────────

const minted = await mint(verified);
const mintedBody = await unwrap(minted);
ok('a receipt is made', minted.ok && !!mintedBody.token, `HTTP ${minted.status}`);
ok('...carrying its layout: no price column, printing on 62 × 100',
  mintedBody.layout?.mode === 'ITEMIZED' && mintedBody.layout.show.price === false && mintedBody.layout.show.sku === true &&
  mintedBody.layout.print?.paperSize === '62x100', JSON.stringify(mintedBody.layout));
ok('...linking to the seller’s status page', mintedBody.layout?.link?.kind === 'SELLER_STATUS' &&
  mintedBody.layout.link.url.endsWith(`/s/${verified.profile.id}`), JSON.stringify(mintedBody.layout?.link));

const page = await publicReceipt(mintedBody.token).then(unwrap);
ok('the receipt page carries its swap’s zone', page.timeZone === 'America/Denver', page.timeZone);
ok('the receipt page carries the layout and the fine print',
  page.layout?.show?.price === false && page.layout.finePrint?.includes('<strong>All sales final.</strong>'), JSON.stringify(page.layout));

await patch({ sellerLookupEnabled: false });
const linkOff = await publicReceipt(mintedBody.token).then(unwrap);
ok('a page turned off since leaves the receipt with no link', linkOff.layout?.link === null, JSON.stringify(linkOff.layout?.link));

await patch({ receiptPrintEnabled: false });
const printOff = await publicReceipt(mintedBody.token).then(unwrap);
ok('printing off says so in the layout', printOff.layout?.print === null, JSON.stringify(printOff.layout?.print));

// ─── Signing in from a receipt ───────────────────────────────────────────────

await patch({ receiptMode: 'STATUS_ONLY', receiptLink: 'SELLER_LOGIN', sellerLoginEnabled: true });
const loginReceipt = await publicReceipt(mintedBody.token).then(unwrap);
ok('a status-page-only receipt links to sign-in with its token',
  loginReceipt.layout?.mode === 'STATUS_ONLY' && loginReceipt.layout.link?.kind === 'SELLER_LOGIN' &&
  loginReceipt.layout.link.url.includes(`/app/auth/login?r=${mintedBody.token}`), JSON.stringify(loginReceipt.layout?.link));

const hint = await fetch(`${BASE}/public/receipts/${mintedBody.token}/sign-in`);
const hintBody = await unwrap(hint);
ok('the sign-in page is told whose email, masked', hint.ok && hintBody.emailHint === 'r•••@patrolkit.invalid', JSON.stringify(hintBody));
ok('...and never the email itself', !JSON.stringify(hintBody).includes(EMAILS.verified));

const requestLink = async (receiptToken) => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receiptToken }),
  });
  const body = await unwrap(res);
  const stored = body.challengeId ? await prisma.contactChallenge.findUnique({ where: { id: body.challengeId } }) : null;
  return { status: res.status, answered: !!body.challengeId, target: stored?.target ?? null };
};
const sent = await requestLink(mintedBody.token);
ok('a link from a receipt goes to the verified email', sent.status === 200 && sent.target === EMAILS.verified, JSON.stringify(sent));

const other = await unwrap(await mint(unverified));
const noHint = await fetch(`${BASE}/public/receipts/${other.token}/sign-in`);
ok('with no verified email, the page gets no hint', noHint.status === 404, `HTTP ${noHint.status}`);
const decoy = await requestLink(other.token);
ok('...and a login with that receipt sends nothing, answering as usual', decoy.status === 200 && decoy.answered && decoy.target === null,
  JSON.stringify(decoy));
const wrong = await requestLink('not-a-receipt-token');
ok('a made-up token answers the same', wrong.status === 200 && wrong.answered && wrong.target === null, JSON.stringify(wrong));

await patch({ sellerLoginEnabled: false });
ok('with sign-in closed, the page gets no hint', (await fetch(`${BASE}/public/receipts/${mintedBody.token}/sign-in`)).status === 404);

// ─── No receipt at all ───────────────────────────────────────────────────────

await patch({ receiptMode: 'NONE' });
const offMint = await mint(verified);
const offBody = await offMint.json();
ok('a swap giving no receipts refuses to make one', offMint.status === 409 && offBody.code === 'RECEIPTS_OFF', `HTTP ${offMint.status} ${offBody.code}`);
ok('...and its receipt pages are a 404', (await publicReceipt(mintedBody.token)).status === 404);
const sellers = await fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers`, { headers: SH }).then(unwrap);
const listedSeller = (sellers.sellers ?? sellers).find((s) => s.id === verified.profile.id);
ok('...and staff aren’t offered a receipt for it', !!listedSeller && !listedSeller.receiptSwaps.some((s) => s.id === swap.id),
  JSON.stringify(listedSeller?.receiptSwaps));

await tidy();
console.log(failed ? `${failed} failed` : 'All assertions passed');
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
