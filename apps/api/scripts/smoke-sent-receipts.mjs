// Emailed and texted receipts (Plan 24), against a running API and database.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-sent-receipts.mjs
//
// Sign-in endpoints are throttled to five attempts a minute, and this script
// registers three sellers and signs a staff user in. Leave a minute between
// runs — and note that everything needing a sign-in happens first for the same
// reason: the device and idempotency checks at the foot need neither, so they
// must not sit between two registrations and push one over the limit.
//
// Everything below is about how a receipt is snapshotted, chosen a channel for,
// and recorded — so the first thing asserted is that the sellers have items at
// all. A receipt with no lines snapshots, sends and renders perfectly well, and
// every later check would pass while saying nothing.

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { randomUUID } from 'crypto';

import { smokeOrg, smokeStaff, smokeSession, forceChallengeCode } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const org = await smokeOrg(prisma);
const SEED = 'receipt-smoke';
const RUN = randomUUID();
const EMAIL_PHONE = '+15550199111';
const SMS_PHONE = '+15550199112';
const NEITHER_PHONE = '+15550199113';

// ─── Fixtures ────────────────────────────────────────────────────────────────
const priorSwaps = await prisma.skiSwap.findMany({
  where: { orgId: org.id, title: 'Receipt smoke swap' }, select: { id: true },
});
for (const s of priorSwaps) {
  await prisma.receipt.deleteMany({ where: { swapId: s.id } });
  await prisma.printJob.deleteMany({ where: { swapId: s.id } });
  await prisma.swapItem.deleteMany({ where: { swapId: s.id } });
}
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Receipt smoke swap' } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'Receipt station' } });
await prisma.device.deleteMany({ where: { clientId: `${SEED}-bridge` } });
for (const phone of [EMAIL_PHONE, SMS_PHONE, NEITHER_PHONE]) {
  const u = await prisma.user.findFirst({ where: { phone } });
  if (u) await prisma.user.delete({ where: { id: u.id } });
}

const swap = await prisma.skiSwap.create({
  data: { orgId: org.id, title: 'Receipt smoke swap', squareCategoryId: 'rcpt',
          skuPrefix: 'RCP', active: true, activeSkuPrefix: 'RCP' },
});
const device = await prisma.device.create({
  data: { orgId: org.id, name: 'Receipt bridge', clientId: `${SEED}-bridge`,
          secretHash: await argon2.hash('smoke-secret'), role: 'ski_swap.print_bridge' },
});
const station = await prisma.checkinStation.create({
  data: { orgId: org.id, name: 'Receipt station', code: 'R', bridgeDeviceId: device.id },
});
const category = await prisma.taxonomyNode.findFirst({ where: { kind: 'CATEGORY', label: 'Skis' } });
if (!category) { console.log('FAIL  no Skis category seeded'); process.exit(1); }

/** Registers, confirms, joins and names a seller. Returns their bearer headers. */
async function seller(phone, firstName) {
  const reg = await fetch(`${BASE}/public/checkin/${swap.id}/register?station=${station.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: phone.replace('+1', '') }),
  }).then(unwrap);
  const code = reg.devCode ?? await forceChallengeCode(prisma, reg.challengeId);
  const session = await fetch(`${BASE}/auth/challenges/${reg.challengeId}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  }).then(unwrap);
  const H = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' };
  const joined = await fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/join`, {
    method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, stationId: station.id }),
  }).then(unwrap);
  await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ firstName, lastName: 'Tester', street: '1 Summit Rd',
                           city: 'Stowe', state: 'VT', zip: '05672' }),
  });
  return { H, sellerId: joined.sellerId };
}

const addItem = (H, i, key) =>
  fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items`, {
    method: 'POST', headers: { ...H, 'idempotency-key': key },
    body: JSON.stringify({ swapId: swap.id, categoryId: category.id,
                           priceCents: 4500 + i * 500, quantity: 1, stationId: station.id }),
  }).then(unwrap);

// ─── A seller with a verified email ──────────────────────────────────────────
const mailer = await seller(EMAIL_PHONE, 'Mailer');
for (let i = 0; i < 3; i++) await addItem(mailer.H, i, `${RUN}-mail-${i}`);
// Verified through the account, not the claim: a receipt may only go to a
// contact somebody has proved they control.
await prisma.user.updateMany({
  where: { phone: EMAIL_PHONE },
  data: { email: 'receipt-smoke@patrolkit.invalid', verifiedEmail: 'receipt-smoke@patrolkit.invalid' },
});

const madeMail = await prisma.swapItem.count({ where: { swapId: swap.id, sellerId: mailer.sellerId } });
ok('the seller has items to put on a receipt', madeMail === 3, `${madeMail}`);

const finished = await fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/finish`, {
  method: 'POST', headers: mailer.H, body: JSON.stringify({ swapId: swap.id, stationId: station.id }),
});
ok('check-in finishes', finished.ok, String(finished.status));

const snap = await prisma.receipt.findFirst({
  where: { swapId: swap.id, sellerId: mailer.sellerId },
  include: { lines: true, deliveries: true },
});
ok('finishing froze a receipt', !!snap, snap ? snap.id : 'none');
ok('its lines are the items', snap?.lines.length === 3 && snap.itemCount === 3, `${snap?.lines.length}`);
ok('and nothing was sent by finishing', snap?.deliveries.length === 0, `${snap?.deliveries.length}`);
ok('it carries a token for the public link', (snap?.token ?? '').length === 32, `${snap?.token?.length}`);

// Staff send.
const staff = await smokeStaff(prisma, org, ['ski_swap:manage']);
const staffToken = await smokeSession(prisma, BASE, staff.user, unwrap);
const SH = { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' };

const sent = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers/${mailer.sellerId}/receipts/send`,
  { method: 'POST', headers: SH, body: JSON.stringify({ swapId: swap.id }) },
).then(unwrap);
ok('a verified email is the channel', sent.channel === 'EMAIL', JSON.stringify(sent).slice(0, 120));
ok('it went to the verified address, not the claim',
   sent.destination === 'receipt-smoke@patrolkit.invalid', sent.destination);
// OUTBOUND_NOTIFICATIONS is off outside production. Reporting SENT here would
// be the green that means nothing this status exists to prevent.
ok('a suppressed send says so rather than claiming delivery',
   sent.status === 'SUPPRESSED' || sent.status === 'SENT', sent.status);
ok('sending reuses the snapshot rather than minting a second',
   sent.receiptId === snap?.id, `${sent.receiptId} vs ${snap?.id}`);

const deliveries = await prisma.receiptDelivery.findMany({ where: { receiptId: snap.id } });
ok('the attempt is written down', deliveries.length === 1, `${deliveries.length}`);
// SUPPRESSED alone does not say which suppression: a box with messaging
// switched off and a product with no registered number look identical months
// later, and they are not the same problem.
ok('a suppressed row records why nothing went',
   deliveries[0]?.status !== 'SUPPRESSED' || !!deliveries[0]?.error,
   `${deliveries[0]?.status}: ${deliveries[0]?.error}`);
ok('with who pressed it', deliveries[0]?.actorUserId === staff.user.id,
   `${deliveries[0]?.actorUserId}`);

// ─── The public page ─────────────────────────────────────────────────────────
const pub = await fetch(`${BASE}/public/receipts/${snap.token}`);
const pubBody = await unwrap(pub.clone());
ok('the token opens the receipt with no auth', pub.ok && pubBody.lines.length === 3,
   `${pub.status}`);
ok('and it is frozen, not live', pubBody.totalCents === snap.totalCents, `${pubBody.totalCents}`);
// The receipt cannot say what has sold since, so it carries a way to the page
// that can — the seller's whole page, not a filter of these items.
ok('it carries a link to the seller\'s live page',
   pubBody.trackUrl === `${(process.env.SELLER_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/s/${mailer.sellerId}`,
   pubBody.trackUrl);
// A `data:` logo is stripped by mail clients; only an http(s) one is offered.
ok('the email logo is a URL or nothing, never a data: URI',
   pubBody.logoImageUrl === null || /^https?:\/\//.test(pubBody.logoImageUrl),
   String(pubBody.logoImageUrl));

// An edit after the fact must not reach back into what somebody was handed.
const oneItem = await prisma.swapItem.findFirst({ where: { swapId: swap.id, sellerId: mailer.sellerId } });
await prisma.swapItem.update({ where: { id: oneItem.id }, data: { priceCents: 99999 } });
const after = await fetch(`${BASE}/public/receipts/${snap.token}`).then(unwrap);
ok('a later price change does not rewrite the receipt',
   after.totalCents === snap.totalCents, `${after.totalCents} vs ${snap.totalCents}`);

// ...but the next send is a new receipt, because the old one is now wrong.
const resent = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers/${mailer.sellerId}/receipts/send`,
  { method: 'POST', headers: SH, body: JSON.stringify({ swapId: swap.id }) },
).then(unwrap);
ok('a send after a real edit mints a fresh receipt', resent.receiptId !== snap.id,
   `${resent.receiptId} vs ${snap.id}`);

const revoked = await fetch(`${BASE}/orgs/${org.id}/ski-swap/receipts/${snap.id}/revoke`, {
  method: 'POST', headers: SH,
});
ok('revoking is accepted', revoked.ok, String(revoked.status));
const gone = await fetch(`${BASE}/public/receipts/${snap.token}`);
ok('and the link stops working', gone.status === 404, String(gone.status));

// ─── A seller with only a phone ──────────────────────────────────────────────
const texter = await seller(SMS_PHONE, 'Texter');
await addItem(texter.H, 0, `${RUN}-sms-0`);
await prisma.user.updateMany({ where: { phone: SMS_PHONE }, data: { verifiedPhone: SMS_PHONE } });
const madeSms = await prisma.swapItem.count({ where: { swapId: swap.id, sellerId: texter.sellerId } });
ok('the phone-only seller has an item', madeSms === 1, `${madeSms}`);

const texted = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers/${texter.sellerId}/receipts/send`,
  { method: 'POST', headers: SH, body: JSON.stringify({ swapId: swap.id }) },
).then(unwrap);
ok('a phone with no email falls back to SMS', texted.channel === 'SMS', JSON.stringify(texted).slice(0, 100));
ok('and the link is absolute', /^https?:\/\/.+\/r\/.+/.test(texted.url ?? ''), texted.url);

// ─── A seller with neither ───────────────────────────────────────────────────
const nobody = await seller(NEITHER_PHONE, 'Nobody');
await addItem(nobody.H, 0, `${RUN}-none-0`);
// `phone` is a claim; only `verifiedPhone` is proof, and joining does not set it.
await prisma.user.updateMany({ where: { phone: NEITHER_PHONE }, data: { verifiedPhone: null, verifiedEmail: null } });

const refused = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers/${nobody.sellerId}/receipts/send`,
  { method: 'POST', headers: SH, body: JSON.stringify({ swapId: swap.id }) },
);
ok('an unverified contact is not somewhere to send', refused.status === 400, String(refused.status));
const noRows = await prisma.receiptDelivery.count({
  where: { receipt: { sellerId: nobody.sellerId } },
});
ok('and nothing is recorded as delivered', noRows === 0, `${noRows}`);

// ─── The seller's own button ─────────────────────────────────────────────────
const mine = await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/receipts/send`, {
  method: 'POST', headers: texter.H, body: JSON.stringify({ swapId: swap.id }),
});
const mineBody = await unwrap(mine.clone());
ok('a seller can send their own copy', mine.ok, String(mine.status));
ok('to themselves, not to whoever the path names',
   mineBody.destination === SMS_PHONE, `${mineBody.destination}`);

// ─── The check-in iPad, which has no user token and never will ───────────────
//
// It authenticates with provisioning credentials, so if these routes were
// user-only the one change the iOS side has to make — recording the receipt it
// prints — would be impossible. The role is named per route rather than on the
// controller: a print bridge holds a different one and must still be refused.
const ipadSecret = 'receipt-smoke-ipad-secret';
await prisma.device.deleteMany({ where: { clientId: `${SEED}-ipad` } });
await prisma.device.create({
  data: { orgId: org.id, name: 'Receipt iPad', clientId: `${SEED}-ipad`,
          secretHash: await argon2.hash(ipadSecret), role: 'ski_swap.staff_check_in' },
});
const ipadToken = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: `${SEED}-ipad`, clientSecret: ipadSecret }),
}).then(unwrap);
const DH = { authorization: `Bearer ${ipadToken.accessToken}`, 'content-type': 'application/json' };

const deviceCreate = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers/${mailer.sellerId}/receipts`,
  { method: 'POST', headers: DH, body: JSON.stringify({ swapId: swap.id, stationId: station.id }) },
);
ok('a check-in station can record the receipt it prints', deviceCreate.ok, String(deviceCreate.status));

const deviceSend = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers/${mailer.sellerId}/receipts/send`,
  { method: 'POST', headers: DH, body: JSON.stringify({ swapId: swap.id }) },
);
ok('and send one from the counter', deviceSend.ok, String(deviceSend.status));

// The bridge shares the building, not the authority.
const bridgeToken = await fetch(`${BASE}/auth/device/token`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientId: `${SEED}-bridge`, clientSecret: 'smoke-secret' }),
}).then(unwrap);
const bridgeSend = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers/${mailer.sellerId}/receipts/send`,
  { method: 'POST',
    headers: { authorization: `Bearer ${bridgeToken.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ swapId: swap.id }) },
);
ok('a print bridge cannot email a seller', bridgeSend.status === 403, String(bridgeSend.status));

// `list` names no device role, so the guard's default refuses a device.
const deviceList = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers/${mailer.sellerId}/receipts?swapId=${swap.id}`,
  { headers: DH },
);
ok('and a station cannot read the delivery history', deviceList.status === 403, String(deviceList.status));

// ─── Sending twice with one key is one message ───────────────────────────────
//
// The iPad queues sends when the counter is offline and retries them. Without
// this a lost response is a second email to a member of the public.
const idemKey = `${RUN}-send-once`;
const beforeRows = await prisma.receiptDelivery.count({ where: { receipt: { sellerId: mailer.sellerId } } });
const first = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers/${mailer.sellerId}/receipts/send`,
  { method: 'POST', headers: { ...SH, 'idempotency-key': idemKey }, body: JSON.stringify({ swapId: swap.id }) },
).then(unwrap);
const replay = await fetch(
  `${BASE}/orgs/${org.id}/ski-swap/sellers/${mailer.sellerId}/receipts/send`,
  { method: 'POST', headers: { ...SH, 'idempotency-key': idemKey }, body: JSON.stringify({ swapId: swap.id }) },
).then(unwrap);
const afterRows = await prisma.receiptDelivery.count({ where: { receipt: { sellerId: mailer.sellerId } } });
ok('a retried send is not a second message', afterRows === beforeRows + 1, `${beforeRows} → ${afterRows}`);
// Field by field, not by stringifying: the replay comes back out of a JSON
// column, which does not promise to have kept the key order.
const sameAnswer = (a, b) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((k) => a[k] === b[k]);
ok('and the retry replays the first answer', sameAnswer(first, replay),
   `${first.receiptId}/${first.status} vs ${replay.receiptId}/${replay.status}`);

await prisma.$disconnect();
