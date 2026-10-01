// Running without SMS (Plan 29), against a running API and a real database.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-no-sms.mjs
//
// With the platform's texting switch off, nothing offers a text and the server
// refuses every path that would send one, saying what to do instead. Turning
// it on brings phone sign-in straight back. The switch is left as it was found.

import { PrismaClient } from '@prisma/client';
import {
  smokeOrg, smokeStaff, smokeSession, smokeSuperAdmin, dropSmokeAdmin, forgetSentCodes,
} from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};
const json = { 'content-type': 'application/json' };

// ─── Fixtures ────────────────────────────────────────────────────────────────
const SEED = 'no-sms-smoke';
const PHONE = '+15550199071';
const EMAIL = `${SEED}@patrolkit.invalid`;
const SELLER_PHONE = '+15550199072';
const SELLER_EMAIL = `${SEED}-seller@patrolkit.invalid`;

const org = await smokeOrg(prisma);
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'No SMS swap' } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'No SMS station' } });
await prisma.user.deleteMany({ where: { OR: [{ phone: { in: [PHONE, SELLER_PHONE] } }, { email: { in: [EMAIL, SELLER_EMAIL] } }] } });
for (const target of [PHONE, SELLER_PHONE, SELLER_EMAIL]) await forgetSentCodes(prisma, target);

const swap = await prisma.skiSwap.create({
  data: { orgId: org.id, title: 'No SMS swap', squareCategoryId: 'nosms', skuPrefix: 'NSM', active: true, activeSkuPrefix: 'NSM' },
});
const station = await prisma.checkinStation.create({ data: { orgId: org.id, name: 'No SMS station', code: 'Z' } });
// Someone with an account, known only by a phone: what phone sign-in would find.
await prisma.user.create({ data: { phone: PHONE, firstName: 'Phone', lastName: 'Only' } });

const admin = await smokeSuperAdmin(prisma);
const A = { ...json, authorization: `Bearer ${await smokeSession(prisma, BASE, admin, unwrap)}` };
const { user: staffUser } = await smokeStaff(prisma, org, ['ski_swap:admin', 'ski_swap:manage', 'ski_swap:report']);
const S = { ...json, authorization: `Bearer ${await smokeSession(prisma, BASE, staffUser, unwrap)}` };

const settings = () => fetch(`${BASE}/admin/settings`, { headers: A }).then(unwrap);
const setSms = (smsEnabled) =>
  fetch(`${BASE}/admin/settings`, { method: 'PATCH', headers: A, body: JSON.stringify({ smsEnabled }) }).then(unwrap);
const features = () => fetch(`${BASE}/public/features`).then(unwrap);
const login = (body) => fetch(`${BASE}/auth/login`, { method: 'POST', headers: json, body: JSON.stringify(body) });

const smsWas = (await settings()).smsEnabled;
await setSms(false);

// ─── Off ─────────────────────────────────────────────────────────────────────
const seen = await settings();
ok('the switch reads off, with readiness and no number', seen.smsEnabled === false
  && typeof seen.smsReadiness?.originationNumber === 'boolean' && !JSON.stringify(seen).includes('+1844'),
  JSON.stringify(seen.smsReadiness));
const pub = await features();
ok('/public/features says so, and nothing else', JSON.stringify(pub) === '{"sms":false}', JSON.stringify(pub));
const staffSees = await fetch(`${BASE}/admin/settings`, { headers: S });
ok('staff who are not super admins cannot read the switch', staffSees.status === 403, `HTTP ${staffSees.status}`);

const known = await login({ phone: PHONE });
const knownBody = await known.json();
const unknown = await login({ phone: '+15550199079' });
const unknownBody = await unknown.json();
ok('phone sign-in is refused with SMS_OFF', known.status === 400 && knownBody.code === 'SMS_OFF',
  `HTTP ${known.status} ${knownBody.code}: ${knownBody.error}`);
ok('...the same for a number nobody has', unknown.status === known.status && unknownBody.code === knownBody.code
  && unknownBody.error === knownBody.error);
ok('...and no code was issued', (await prisma.contactChallenge.count({ where: { target: PHONE } })) === 0);

const register = (body) => fetch(`${BASE}/public/checkin/${swap.id}/register?station=${station.id}`, {
  method: 'POST', headers: json, body: JSON.stringify(body),
});
const both = await unwrap(await register({ phone: SELLER_PHONE.replace('+1', ''), email: SELLER_EMAIL }));
ok('check-in with a phone and an email sends an email link', both.channel === 'email', JSON.stringify(both).slice(0, 80));
const phoneOnly = await register({ phone: '5550199073' });
const phoneOnlyBody = await phoneOnly.json();
ok('check-in with only a phone asks for an email', phoneOnly.status === 400 && phoneOnlyBody.error === 'Use your email to sign in.',
  `HTTP ${phoneOnly.status}: ${phoneOnlyBody.error}`);

// A seller with an unverified phone, set up the way staff would at a counter.
const created = await fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers`, {
  method: 'POST', headers: S,
  body: JSON.stringify({ firstName: 'Phone', lastName: 'Seller', phone: '5550199074' }),
});
const sellerRow = await unwrap(created);
const verify = await fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers/${sellerRow.id}/verify/phone/initiate`, { method: 'POST', headers: S });
const verifyBody = await verify.json();
ok('staff phone verification is refused', verify.status === 400 && verifyBody.error === 'Texting is off. Verify their email.',
  `HTTP ${verify.status}: ${verifyBody.error}`);

// The same seller's phone, proved before the switch went off: still verified,
// never texted.
await prisma.user.update({
  where: { id: sellerRow.userId },
  data: { verifiedPhone: '+15550199074', phoneVerifiedAt: new Date(), verifiedEmail: `${SEED}-paid@patrolkit.invalid`, email: `${SEED}-paid@patrolkit.invalid` },
});
const listed = await fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers/${sellerRow.id}`, { headers: S }).then(unwrap);
ok('a phone verified before stays verified, and receipts go by email', !!listed.phoneVerifiedAt && listed.receiptChannel === 'EMAIL',
  `${listed.phoneVerifiedAt} ${listed.receiptChannel}`);
const sendText = await fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers/${sellerRow.id}/receipts/send`, {
  method: 'POST', headers: S, body: JSON.stringify({ swapId: swap.id, channel: 'SMS' }),
});
const sendTextBody = await sendText.json();
ok('a receipt asked for by text is refused', sendText.status === 400 && sendTextBody.error === 'Texting is off. Send it by email.',
  `HTTP ${sendText.status}: ${sendTextBody.error}`);
const sendDefault = await unwrap(await fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers/${sellerRow.id}/receipts/send`, {
  method: 'POST', headers: S, body: JSON.stringify({ swapId: swap.id }),
}));
ok('...and with no channel asked for, it goes by email', sendDefault.channel === 'EMAIL', JSON.stringify(sendDefault).slice(0, 100));

// ─── On ──────────────────────────────────────────────────────────────────────
await setSms(true);
ok('/public/features follows the switch at once', (await features()).sms === true);
const back = await unwrap(await login({ phone: PHONE }));
ok('turned on, phone sign-in issues a challenge again', back.channel === 'phone' && !!back.challengeId, JSON.stringify(back).slice(0, 80));

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await setSms(smsWas);
ok('the switch is left as it was found', (await settings()).smsEnabled === smsWas, `${smsWas}`);

await prisma.receipt.deleteMany({ where: { swapId: swap.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.checkinStation.delete({ where: { id: station.id } });
for (const target of [PHONE, SELLER_PHONE, SELLER_EMAIL]) await forgetSentCodes(prisma, target);
await prisma.user.deleteMany({
  where: { OR: [{ phone: { in: [PHONE, SELLER_PHONE, '+15550199074'] } }, { email: { startsWith: SEED } }] },
});
await dropSmokeAdmin(prisma);
await prisma.$disconnect();

console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
