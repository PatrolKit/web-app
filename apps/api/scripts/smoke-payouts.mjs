// Payouts (Plan 25), against a running API and database.
//
//   PAYOUTS_STUB=1 \
//   PAYPAL_STUB_LOG=/tmp/paypal-stub.log \
//   SMOKE_SALES_FILE=/tmp/smoke-sales.json \
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-payouts.mjs
//
// The stub file paths must match between the two processes: this script writes
// the sales the server will read, and counts the calls the server makes.
//
// Money, so the things asserted here are the ones that cannot be proved by
// reading our own database back:
//
//   - pressing send twice reaches PayPal once, counted at the stub;
//   - an unapproved line is never in a batch;
//   - a line leaves SENDING only through a verified webhook or the sweep;
//   - a forged webhook aimed at a line in flight changes nothing.
//
// This script signs in once, at the top, before anything else.
//
// Everything below is about how sales become lines, so the first thing asserted
// is that the run has lines at all. A run with none approves, sends and
// reconciles perfectly while proving nothing.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { writeFileSync, readFileSync, writeFileSync as write } from 'fs';

import { smokeOrg, smokeStaff, smokeSession } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const STUB_LOG = process.env.PAYPAL_STUB_LOG ?? '/tmp/paypal-stub.log';
const SALES_FILE = process.env.SMOKE_SALES_FILE ?? '/tmp/smoke-sales.json';
const STUB_SIG = process.env.PAYPAL_STUB_SIG ?? 'stub-signature';

const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

/** What the stub has been asked to do, since the log was last truncated. */
const stubCalls = (call) =>
  readFileSync(STUB_LOG, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => !call || e.call === call);

const truncateStubLog = () => write(STUB_LOG, '');

const org = await smokeOrg(prisma);
const SEED = 'payout-smoke';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const priorSwaps = await prisma.skiSwap.findMany({
  where: { orgId: org.id, title: 'Payout smoke swap' }, select: { id: true },
});
for (const s of priorSwaps) {
  const runs = await prisma.payoutRun.findMany({ where: { swapId: s.id }, select: { id: true } });
  for (const r of runs) await prisma.payoutRun.delete({ where: { id: r.id } });
  await prisma.swapItem.deleteMany({ where: { swapId: s.id } });
}
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Payout smoke swap' } });

const SELLERS = [
  // `tiny` sells one dollar of gear: eighty cents after the patrol's cut, which
  // is the smallest payout the system can produce and goes out like any other.
  { key: 'paypal',  phone: '+15550198201', method: 'PAYPAL', target: 'EMAIL',    handle: null,       email: `${SEED}-paypal@patrolkit.invalid` },
  { key: 'venmo',   phone: '+15550198202', method: 'VENMO',  target: 'VENMO_ID', handle: '@smoke-venmo', email: null },
  { key: 'check',   phone: '+15550198203', method: 'CHECK',  target: null,       handle: null,       email: null },
  { key: 'donate',  phone: '+15550198204', method: 'DONATE', target: null,       handle: null,       email: null },
  { key: 'tiny',    phone: '+15550198205', method: 'PAYPAL', target: 'EMAIL',    handle: null,       email: `${SEED}-tiny@patrolkit.invalid` },
];
for (const s of SELLERS) {
  const u = await prisma.user.findFirst({ where: { phone: s.phone } });
  if (u) await prisma.user.delete({ where: { id: u.id } });
}

await prisma.skiSwapSettings.upsert({
  where: { orgId: org.id },
  update: { commissionBasisPoints: 2000 },
  create: { orgId: org.id, commissionBasisPoints: 2000 },
});

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, title: 'Payout smoke swap', squareCategoryId: 'pay',
    locationId: 'stub-location', skuPrefix: 'PAY', active: true, activeSkuPrefix: 'PAY',
  },
});

const sellerIds = {};
for (const s of SELLERS) {
  const user = await prisma.user.create({
    data: {
      id: createId(), firstName: s.key, lastName: 'Smoke',
      phone: s.phone, verifiedPhone: s.phone, phoneVerifiedAt: new Date(),
      ...(s.email ? { email: s.email, verifiedEmail: s.email, emailVerifiedAt: new Date() } : {}),
      street: '12 Summit Rd', city: 'Stowe', state: 'VT', zip: '05672',
      payoutMethod: s.method, payoutTarget: s.target, payoutHandle: s.handle,
    },
  });
  const membership = await prisma.membership.create({
    data: { id: createId(), userId: user.id, orgId: org.id, updatedAt: new Date() },
  });
  const profile = await prisma.sellerProfile.create({
    data: { id: createId(), membershipId: membership.id },
  });
  sellerIds[s.key] = profile.id;
}

// Items. The prices are chosen so each seller's arithmetic is checkable by eye
// at 20%: $100.00 gross → $20.00 to the patrol → $80.00 out.
const ITEMS = [
  { key: 'paypal', sku: 'PAY-001', price: 5000,  variation: 'var-paypal-1', qty: 1, collected: 5000 },
  { key: 'paypal', sku: 'PAY-002', price: 5000,  variation: 'var-paypal-2', qty: 1, collected: 4000 }, // discounted
  { key: 'venmo',  sku: 'PAY-003', price: 12000, variation: 'var-venmo-1',  qty: 1, collected: 12000 },
  { key: 'check',  sku: 'PAY-004', price: 8000,  variation: 'var-check-1',  qty: 1, collected: 8000 },
  { key: 'donate', sku: 'PAY-005', price: 6000,  variation: 'var-donate-1', qty: 1, collected: 6000 },
  { key: 'tiny',   sku: 'PAY-006', price: 100,   variation: 'var-tiny-1',   qty: 1, collected: 100 },
  // Refunded in full: sold, then returned, so it owes nobody anything.
  { key: 'paypal', sku: 'PAY-007', price: 9000,  variation: 'var-paypal-3', qty: 1, collected: 9000, refunded: 1 },
];
for (const item of ITEMS) {
  await prisma.swapItem.create({
    data: {
      id: createId(), swapId: swap.id, orgId: org.id, sellerId: sellerIds[item.key],
      name: `${item.key} item ${item.sku}`, sku: item.sku, priceCents: item.price,
      originalQuantity: 1, squareVariationId: item.variation, consignedAt: new Date(),
    },
  });
}

// After the swap was created, which is where the window starts by default.
// A sale timestamped before its own swap is a sale the run will not see —
// which is correct, and is what the out-of-window row below proves.
const soldAt = new Date().toISOString();
const sales = ITEMS.map((item, i) => ({
  orderId: `stub-order-${i}`,
  variationId: item.variation,
  quantity: item.qty,
  collectedCents: item.collected,
  refundedQuantity: item.refunded ?? 0,
  soldAt,
}));
// A sale of something this swap never had: money the org took that nobody is
// being paid for, which the run must report rather than drop.
sales.push({
  orderId: 'stub-order-orphan', variationId: 'var-not-ours',
  quantity: 1, collectedCents: 2500, refundedQuantity: 0, soldAt,
});
// Last year, for the same item as PAY-001. Outside the run's window, so it must
// not be paid a second time — the window is what makes a run reproducible.
sales.push({
  orderId: 'stub-order-last-year', variationId: 'var-paypal-1',
  quantity: 1, collectedCents: 5000, refundedQuantity: 0,
  soldAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
});
writeFileSync(SALES_FILE, JSON.stringify(sales, null, 2));
truncateStubLog();

const { user: staff } = await smokeStaff(prisma, org, [
  'ski_swap:admin', 'ski_swap:manage', 'ski_swap:report', 'org:read',
]);
const token = await smokeSession(prisma, BASE, staff, unwrap);
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });

console.log('\n── Building the run ──────────────────────────────────────────');

const run = await api(`/orgs/${org.id}/ski-swap/swaps/${swap.id}/payout-runs`, {
  method: 'POST', body: JSON.stringify({}),
}).then(unwrap);

// The fixture, before any behaviour. Five sellers sold something; if this is
// wrong every assertion below is about an empty run.
ok('the run has a line for each of the five sellers', run.lines?.length === 5,
  `got ${run.lines?.length}`);
if (run.lines?.length !== 5) { await finish(); }

const byName = (key) => run.lines.find((l) => l.sellerName.startsWith(key));

const paypalLine = byName('paypal');
ok('owed is the listed price, not what the register took',
  paypalLine.grossCents === 10000,
  `$100.00 listed across two sold items, one of them discounted to $40.00 — got ${paypalLine.grossCents}`);
ok('a sale from before the window is not paid again',
  paypalLine.items.filter((i) => i.sku === 'PAY-001').length === 1,
  'PAY-001 sold once in the window and once last year');
ok('a fully refunded item owes nothing',
  paypalLine.items.every((i) => i.sku !== 'PAY-007'),
  'PAY-007 sold and came back');
ok('the commission is 20% of gross, rounded once per seller',
  paypalLine.commissionCents === 2000 && paypalLine.netCents === 8000,
  `${paypalLine.commissionCents}/${paypalLine.netCents}`);

ok('a Venmo seller is addressed by handle',
  byName('venmo').destinationType === 'VENMO_ID' && byName('venmo').destination === '@smoke-venmo');
ok('a donated payout is not pending anything',
  byName('donate').status === 'DONATED');
// There is no floor. The money is the seller's however small it is, and a
// payout nobody sends is a payout somebody has to chase.
ok('a payout of eighty cents is treated like any other',
  byName('tiny').status === 'PENDING' && byName('tiny').netCents === 80 &&
  byName('tiny').statusNote === null,
  `got ${byName('tiny').status} / ${byName('tiny').netCents} / ${byName('tiny').statusNote}`);
ok('a check line starts where every other line starts',
  byName('check').status === 'PENDING');

// Money the org took that nobody is being paid for. Kept on the run rather than
// logged, because a log line nobody reads is the same as dropping it.
ok('a sale matching no item of this swap is reported, not dropped',
  run.unmatchedSales?.length === 1 &&
  run.unmatchedSales[0].orderId === 'stub-order-orphan' &&
  run.unmatchedSales[0].collectedCents === 2500,
  JSON.stringify(run.unmatchedSales));

console.log('\n── Approval ──────────────────────────────────────────────────');

// Only the PayPal seller. The Venmo line stays unapproved on purpose: the whole
// point of the next assertion is that an unapproved line is not in the batch.
await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}/approve`, {
  method: 'POST', body: JSON.stringify({ lineIds: [paypalLine.id], approved: true }),
}).then(unwrap);

const afterApprove = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}`).then(unwrap);
ok('approving records who approved it',
  afterApprove.lines.find((l) => l.id === paypalLine.id).approvedBy === staff.id);
ok('approving one line leaves the others alone',
  afterApprove.lines.find((l) => l.id === byName('venmo').id).status === 'PENDING');

const wrongCount = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}/send`, {
  method: 'POST', body: JSON.stringify({ expectedLineCount: 99 }),
});
ok('a send whose count disagrees with the server is refused',
  wrongCount.status === 409, `HTTP ${wrongCount.status}`);
ok('...and nothing reached PayPal', stubCalls('createBatch').length === 0);

console.log('\n── Sending ───────────────────────────────────────────────────');

await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}/send`, {
  method: 'POST', body: JSON.stringify({ expectedLineCount: 1 }),
}).then(unwrap);

const firstBatch = stubCalls('createBatch');
ok('the send reached PayPal once', firstBatch.length === 1, `got ${firstBatch.length}`);
ok('the batch holds only the approved line',
  firstBatch[0]?.items.length === 1 && firstBatch[0].items[0].senderItemId === paypalLine.id);
ok('the batch is for the net amount, not the gross',
  firstBatch[0]?.items[0].amountCents === 8000);
ok('an unapproved Venmo line was not in it',
  !firstBatch[0]?.items.some((i) => i.senderItemId === byName('venmo').id));

const sending = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}`).then(unwrap);
ok('an accepted-but-unpaid batch leaves the line SENDING, not SENT',
  sending.lines.find((l) => l.id === paypalLine.id).status === 'SENDING');
ok('...and sentAt is still empty, because nothing has arrived',
  sending.lines.find((l) => l.id === paypalLine.id).sentAt === null);

// The one that matters. Sending again must re-post the same sender_batch_id so
// PayPal declines to pay it twice — not mint a new one.
await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}/send`, {
  method: 'POST', body: JSON.stringify({ expectedLineCount: 1 }),
}).then(unwrap);

const both = stubCalls('createBatch');
ok('pressing send twice reaches PayPal twice',
  both.length === 2, `got ${both.length}`);
ok('...under the same sender_batch_id, so only one batch exists',
  both[0].senderBatchId === both[1].senderBatchId,
  `${both[0].senderBatchId} vs ${both[1].senderBatchId}`);
ok('...and PayPal deduped the second',
  stubCalls('createBatch.deduped').length === 1);

console.log('\n── Webhooks ──────────────────────────────────────────────────');

const webhookBody = (status) => JSON.stringify({
  event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  resource: {
    payout_item_id: firstBatch[0].items[0].senderItemId,
    payout_batch_id: `stub-batch-${both[0].senderBatchId}`,
    transaction_status: status,
    payout_item: { sender_item_id: paypalLine.id },
  },
});

const forged = await fetch(`${BASE}/webhooks/paypal/${org.id}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'paypal-transmission-sig': 'not-the-signature' },
  body: webhookBody('SUCCESS'),
});
ok('a forged webhook is answered 200, so PayPal does not retry it',
  forged.status === 200, `HTTP ${forged.status}`);

const afterForged = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}`).then(unwrap);
ok('...but it changed nothing — an unverified webhook is an unauthenticated write',
  afterForged.lines.find((l) => l.id === paypalLine.id).status === 'SENDING',
  `status is now ${afterForged.lines.find((l) => l.id === paypalLine.id).status}`);

await fetch(`${BASE}/webhooks/paypal/${org.id}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'paypal-transmission-sig': STUB_SIG },
  body: webhookBody('SUCCESS'),
});

const afterReal = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}`).then(unwrap);
const paid = afterReal.lines.find((l) => l.id === paypalLine.id);
ok('a verified webhook moves the line to paid', paid.status === 'SENT', `got ${paid.status}`);
ok('...and stamps when it arrived', !!paid.sentAt);

console.log('\n── The sweep, for the webhook that never comes ───────────────');

// Same proof by the other road: approve and send the Venmo line, then resolve
// it with the sweep instead of a webhook. If only one of the two paths worked,
// the other would be silently covering for it.
//
// The eighty-cent line rides along, because there is no floor and the way to
// show that is a batch with eighty cents in it — not a status that merely
// failed to say otherwise.
await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}/approve`, {
  method: 'POST',
  body: JSON.stringify({ lineIds: [byName('venmo').id, byName('tiny').id], approved: true }),
}).then(unwrap);
await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}/send`, {
  method: 'POST', body: JSON.stringify({ expectedLineCount: 2 }),
}).then(unwrap);

const venmoSending = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}`).then(unwrap);
ok('the second send is its own batch, under a new attempt',
  stubCalls('createBatch').length === 3 &&
  stubCalls('createBatch')[2].senderBatchId !== both[0].senderBatchId);
ok('an eighty-cent payout is actually handed to PayPal',
  stubCalls('createBatch')[2].items.some((i) => i.amountCents === 80),
  JSON.stringify(stubCalls('createBatch')[2].items.map((i) => i.amountCents)));
ok('the Venmo line is in flight',
  venmoSending.lines.find((l) => l.id === byName('venmo').id).status === 'SENDING');
const venmoItem = stubCalls('createBatch')[2].items
  .find((i) => i.senderItemId === byName('venmo').id);
ok('a Venmo payout is addressed as a user handle',
  venmoItem?.recipient.recipient_type === 'USER_HANDLE' &&
  venmoItem?.recipient.recipient_wallet === 'Venmo');
ok('...with the @ stripped, so two spellings are one destination',
  venmoItem?.recipient.receiver === 'smoke-venmo');

await api(`/orgs/${org.id}/ski-swap/payout-runs/reconcile`, { method: 'POST' }).then(unwrap);

const swept = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}`).then(unwrap);
ok('the sweep resolves a line no webhook arrived for',
  swept.lines.find((l) => l.id === byName('venmo').id).status === 'SENT');
ok('...including the eighty-cent one',
  swept.lines.find((l) => l.id === byName('tiny').id).status === 'SENT');
ok('...and a line already paid is not touched again',
  swept.lines.find((l) => l.id === paypalLine.id).sentAt === paid.sentAt);

console.log('\n── Checks and reports ────────────────────────────────────────');

const checks = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}/checks`).then(unwrap);
ok('only the check seller is on the check register',
  checks.length === 1 && checks[0].sellerName.startsWith('check'), `got ${checks.length}`);
ok('the check is for the net amount', checks[0]?.amountCents === 6400,
  `$80.00 less 20% — got ${checks[0]?.amountCents}`);

const csv = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}/checks.csv`).then((r) => r.text());
const csvRow = csv.split('\r\n')[1] ?? '';
ok('the CSV carries the phone number as a readable number',
  csvRow.includes('"(555) 019-8203"'), csvRow);
ok('the CSV amount is a bare decimal the column can be summed on',
  csvRow.includes(',64.00,'), csvRow);
ok('the CSV carries the address', csvRow.includes('"12 Summit Rd"'));

await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}/lines/${byName('check').id}/check`, {
  method: 'POST', body: JSON.stringify({ checkNumber: '1043', sentAt: new Date().toISOString() }),
}).then(unwrap);
const afterCheck = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}`).then(unwrap);
ok('recording a check marks it paid',
  afterCheck.lines.find((l) => l.id === byName('check').id).status === 'PAID_BY_CHECK');

const discounts = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}/discounts`).then(unwrap);
ok('the discount report finds the item sold under its listed price',
  discounts.discounts.length === 1 && discounts.discounts[0].sku === 'PAY-002',
  `${discounts.discounts.length} found`);
ok('...and totals what it cost the patrol',
  discounts.totalGapCents === 1000, `got ${discounts.totalGapCents}`);

console.log('\n── Closing ───────────────────────────────────────────────────');

const secondRun = await api(`/orgs/${org.id}/ski-swap/swaps/${swap.id}/payout-runs`, {
  method: 'POST', body: JSON.stringify({}),
});
ok('a second run over the same sales is refused while one is open',
  secondRun.status === 409, `HTTP ${secondRun.status}`);

await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}/close`, { method: 'POST' }).then(unwrap);
const closed = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}`).then(unwrap);
ok('closing a run closes it', closed.status === 'CLOSED');

const lateApprove = await api(`/orgs/${org.id}/ski-swap/payout-runs/${run.id}/approve`, {
  method: 'POST', body: JSON.stringify({ lineIds: [byName('donate').id], approved: true }),
});
ok('a closed run approves nothing further', lateApprove.status === 409, `HTTP ${lateApprove.status}`);

await finish();

async function finish() {
  console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}
