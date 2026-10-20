// Payouts (Plan 25, reworked by Plan 52), against a running API and database.
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
//   - a run is sent once, and only when everyone in it is approved;
//   - a total that changed since approval stops the whole send;
//   - a line leaves SENDING only through a verified webhook or the sweep;
//   - a forged webhook aimed at a line in flight changes nothing;
//   - a payment PayPal didn't make frees the seller for another run, where
//     they're paid.
//
// This script signs in once, at the top, before anything else.
//
// Everything below is about how sales become payouts, so the first thing
// asserted is that there are sellers to pay at all. A run with nobody in it
// approves, sends and reconciles perfectly while proving nothing.

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
  // PayPal, but the email was never verified: offered to no run (D3, D16).
  { key: 'unverified', phone: '+15550198206', method: 'PAYPAL', target: 'EMAIL', handle: null, email: `${SEED}-unverified@patrolkit.invalid`, unverified: true },
  // Sells nothing in Square: their items are comped (Plan 53).
  { key: 'comp', phone: '+15550198207', method: 'CHECK', target: null, handle: null, email: null },
  // Their ticket was scanned twice in one sale, and the extra settled outside Square.
  { key: 'twice', phone: '+15550198208', method: 'CHECK', target: null, handle: null, email: null },
  // Their unpriced ticket was rung up at three prices in one sale; one line is theirs.
  { key: 'lines', phone: '+15550198209', method: 'CHECK', target: null, handle: null, email: null },
  // Their ticket sold in two different sales; the first was really another ticket.
  { key: 'across', phone: '+15550198210', method: 'CHECK', target: null, handle: null, email: null },
];
for (const s of SELLERS) {
  const u = await prisma.user.findFirst({ where: { phone: s.phone } });
  if (u) await prisma.user.delete({ where: { id: u.id } });
}

await prisma.skiSwapSettings.upsert({
  where: { orgId: org.id },
  update: { commissionBasisPoints: 2000, paypalFeeFlatCents: 25, paypalFeeBps: 0, paypalFeeCapCents: 0 },
  create: { orgId: org.id, commissionBasisPoints: 2000 },
});

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, slug: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title: 'Payout smoke swap', squareCategoryId: 'pay',
    locationId: 'stub-location', skuPrefix: 'PAY', active: true, activeSkuPrefix: 'PAY',
  },
});

const sellerIds = {};
for (const s of SELLERS) {
  const user = await prisma.user.create({
    data: {
      id: createId(), firstName: s.key, lastName: 'Smoke',
      phone: s.phone, verifiedPhone: s.phone, phoneVerifiedAt: new Date(),
      ...(s.email ? (s.unverified ? { email: s.email } : { email: s.email, verifiedEmail: s.email, emailVerifiedAt: new Date() }) : {}),
      street: '12 Summit Rd', city: 'Stowe', state: 'VT', zip: '05672',
      payoutMethod: s.method, payoutTarget: s.target, payoutHandle: s.handle,
      // Scanned from the seller's code at the counter: only then is Venmo paid (Plan 35).
      payoutHandleScannedAt: s.method === 'VENMO' ? new Date() : null,
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
  { key: 'unverified', sku: 'PAY-008', price: 3000, variation: 'var-unverified-1', qty: 1, collected: 3000 },
  // One ticket rung up as a quantity of 2: the customer was charged twice.
  { key: 'twice', sku: 'PAY-020', price: 2000, variation: 'var-twice-1', qty: 2, collected: 4000 },
];
const addItem = (item) => prisma.swapItem.create({
  data: {
    id: createId(), swapId: swap.id, orgId: org.id, sellerId: sellerIds[item.key],
    name: `${item.key} item ${item.sku}`, sku: item.sku, priceCents: item.price,
    originalQuantity: 1, squareVariationId: item.variation, consignedAt: new Date(),
  },
});
for (const item of ITEMS) await addItem(item);
// Unsold in Square, for comps (Plan 53): priced, priced, and unpriced.
const COMPS = [
  { key: 'comp', sku: 'PAY-012', price: 4000, variation: 'var-comp-1' },
  { key: 'comp', sku: 'PAY-013', price: 2000, variation: 'var-comp-2' },
  { key: 'comp', sku: 'PAY-014', price: null, variation: 'var-comp-3' },
];
const compItemIds = {};
for (const c of COMPS) compItemIds[c.sku] = (await addItem(c)).id;

// After the swap was created: a swap's sales are everything since it began (D2).
const soldAt = () => new Date().toISOString();
const sales = ITEMS.map((item, i) => ({
  orderId: `stub-order-${i}`,
  paymentId: `stubpay${i}abcdef`,
  variationId: item.variation,
  quantity: item.qty,
  // What the register rang it up at, before any discount.
  unitPriceCents: item.price,
  collectedCents: item.collected,
  refundedQuantity: item.refunded ?? 0,
  soldAt: soldAt(),
}));
// PAY-021, unpriced, rung up at $10, $20 and $7 in one sale: held whole until
// Sales check says which line is its own.
const linesItemId = (await addItem({ key: 'lines', sku: 'PAY-021', price: null, variation: 'var-lines-1' })).id;
for (const [lineUid, cents] of [['L10', 1000], ['L20', 2000], ['L7', 700]]) {
  sales.push({ orderId: 'stub-order-lines', paymentId: 'stubpaylines', lineUid, variationId: 'var-lines-1', quantity: 1, unitPriceCents: cents, collectedCents: cents, refundedQuantity: 0, soldAt: soldAt() });
}
// PAY-022, $89, sold in two different sales: one was another ticket's.
const acrossItemId = (await addItem({ key: 'across', sku: 'PAY-022', price: 8900, variation: 'var-across-1' })).id;
for (const n of [1, 2]) {
  sales.push({ orderId: `stub-order-across-${n}`, paymentId: `stubpayacross${n}`, lineUid: `A${n}`, variationId: 'var-across-1', quantity: 1, unitPriceCents: 8900, collectedCents: 8900, refundedQuantity: 0, soldAt: soldAt() });
}
// A sale of something this swap never had: money the org took that nobody is
// being paid for, which "Before you pay" must show rather than drop (D14).
sales.push({
  orderId: 'stub-order-orphan', paymentId: 'stubpayorphan', variationId: 'var-not-ours',
  quantity: 1, collectedCents: 2500, refundedQuantity: 0, soldAt: soldAt(),
});
const saveSales = () => writeFileSync(SALES_FILE, JSON.stringify(sales, null, 2));
saveSales();
truncateStubLog();

const { user: staff } = await smokeStaff(prisma, org, [
  'ski_swap:admin', 'ski_swap:manage', 'ski_swap:report', 'org:read',
]);
const token = await smokeSession(prisma, BASE, staff, unwrap);
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
const O = `/orgs/${org.id}/ski-swap`;
const post = (path, body = {}) => api(`${O}${path}`, { method: 'POST', body: JSON.stringify(body) });
const getRun = (id) => api(`${O}/payout-runs/${id}`).then(unwrap);
const summary = () => api(`${O}/swaps/${swap.id}/payouts-summary`).then(unwrap);
const line = (run, key) => run.lines.find((l) => l.sellerName.startsWith(key));
const webhook = (sig, body) => fetch(`${BASE}/webhooks/paypal/${org.id}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'paypal-transmission-sig': sig }, body: JSON.stringify(body),
});
const itemEvent = (lineId, batchId, status, extra = {}) => ({
  event_type: 'PAYMENT.PAYOUTS-ITEM.X',
  resource: { payout_item_id: `item-${lineId}`, payout_batch_id: batchId, transaction_status: status, payout_item: { sender_item_id: lineId }, ...extra },
});

console.log('\n── Before you pay ────────────────────────────────────────────');

const before = await summary();
ok('the Payouts page reads the swap', before.swapId === swap.id && before.salesError === null, before.salesError ?? '');
ok('three sellers are ready for a PayPal run and three for a check run',
  before.ready?.PAYPAL === 3 && before.ready?.CHECK === 3, JSON.stringify(before.ready));
ok('the seller with an unverified PayPal email is listed to fix, not offered',
  before.missingDetails?.length === 1 && before.missingDetails[0].sellerId === sellerIds.unverified && before.missingDetails[0].key === 'PAYPAL_UNVERIFIED',
  JSON.stringify(before.missingDetails));
ok('a sale matching no ticket is shown, not dropped',
  before.salesCheck?.unmatched?.some((u) => u.collectedCents === 2500), JSON.stringify(before.salesCheck?.unmatched));
ok('the donor is listed, not paid', before.donated?.length === 1 && before.donated[0].sellerId === sellerIds.donate);
ok('the discount report finds the item sold under its listed price',
  before.discounts?.length === 1 && before.discounts[0].sku === 'PAY-002', JSON.stringify(before.discounts));

console.log('\n── Building a PayPal run ─────────────────────────────────────');

const { id: runId } = await post(`/swaps/${swap.id}/payout-runs`, { kind: 'PAYPAL' }).then(unwrap);
const empty = await getRun(runId);
ok('a new run starts empty, and open', empty.lines?.length === 0 && empty.status === 'OPEN' && empty.kind === 'PAYPAL');

const choices = await api(`${O}/payout-runs/${runId}/choices`).then(unwrap);
ok('the picker offers only PayPal and Venmo sellers with complete details',
  choices.length === 3 && choices.every((c) => ['PAYPAL', 'VENMO'].includes(c.method)),
  JSON.stringify(choices.map((c) => c.name)));

const added = await post(`/payout-runs/${runId}/sellers`, { sellerIds: [sellerIds.paypal, sellerIds.venmo, sellerIds.tiny, sellerIds.check, sellerIds.unverified] }).then(unwrap);
const result = (key) => added.results.find((r) => r.sellerId === sellerIds[key])?.result;
ok('adding answers per seller', result('paypal') === 'added' && result('venmo') === 'added' && result('tiny') === 'added');
ok('...refusing a check seller in a PayPal run', result('check') === 'wrong_method');
ok('...and a seller whose details are incomplete', result('unverified') === 'incomplete_details');

const { id: otherId } = await post(`/swaps/${swap.id}/payout-runs`, { kind: 'PAYPAL' }).then(unwrap);
const twice = await post(`/payout-runs/${otherId}/sellers`, { sellerIds: [sellerIds.paypal] }).then(unwrap);
ok('a seller can’t be in two runs of a swap at once', twice.results[0].result === 'in_another_run');
const delOther = await api(`${O}/payout-runs/${otherId}`, { method: 'DELETE' });
ok('an empty run can be deleted', delOther.status === 200, `HTTP ${delOther.status}`);
const delFull = await api(`${O}/payout-runs/${runId}`, { method: 'DELETE' });
ok('...a run with sellers in it can’t', delFull.status === 409, `HTTP ${delFull.status}`);

let run = await getRun(runId);
const paypal = line(run, 'paypal');
ok('owed is the listed price, not what the register took',
  paypal.totals.grossCents === 10000 && paypal.totals.netCents === 8000,
  JSON.stringify(paypal.totals));
ok('a fully refunded item owes nothing', paypal.items.every((i) => i.sku !== 'PAY-007'));
ok('each item carries its receipt and a link to the sale', paypal.items.every((i) => i.receipt === 'stub' && i.saleUrl?.includes('stubpay')),
  JSON.stringify(paypal.items.map((i) => [i.receipt, i.saleUrl])));
ok('nothing is frozen before money moves', run.lines.every((l) => !l.frozen));
// PAY-002 was discounted at the register: Sales check flags a sale paid at
// another price, and the flag blocks the seller until it's settled (D8).
ok('a sale paid at another price flags its seller, saying how to fix it',
  paypal.flags.length === 1 && /PAY-002: Sold for \$40\.00; PatrolKit says \$50\.00/.test(paypal.flags[0].text) && /Sales check/.test(paypal.flags[0].fix),
  JSON.stringify(paypal.flags));
ok('...and nobody else is flagged', line(run, 'venmo').flags.length === 0 && line(run, 'tiny').flags.length === 0);
ok('a Venmo seller is shown by handle', line(run, 'venmo').destination === '@smoke-venmo');
ok('an eighty-cent payout is owed like any other', line(run, 'tiny').totals.netCents === 80);

console.log('\n── Approval ──────────────────────────────────────────────────');

const approve = (l, approved = true) => post(`/payout-runs/${runId}/lines/${l.id}/approve`, { approved });
const blocked = await approve(paypal);
ok('a flagged seller can’t be approved', blocked.status === 409, `HTTP ${blocked.status}`);
// Staff keep PatrolKit's price in Sales check: the seller is paid the listed price.
const kept = await post(`/swaps/${swap.id}/sales-check/price-kept`, { orderId: 'stub-order-1', lineUid: 'line-1' });
ok('keeping PatrolKit’s price in Sales check clears the flag', kept.status < 300 && (await getRun(runId)).lines.every((l) => l.flags.length === 0), `HTTP ${kept.status}`);
const a1 = await approve(paypal).then(unwrap);
ok('approving records the total the approver saw', a1.approvedNetCents === 8000, JSON.stringify(a1));
const early = await post(`/payout-runs/${runId}/send`, { expectedLineCount: 1 });
ok('Send is refused while anyone still needs review', early.status === 400, `HTTP ${early.status}`);
ok('...and nothing reached PayPal', stubCalls('createBatch').length === 0);

await approve(line(run, 'venmo'));
await approve(line(run, 'tiny'));
const wrongCount = await post(`/payout-runs/${runId}/send`, { expectedLineCount: 99 });
ok('a send whose count disagrees with the server is refused', wrongCount.status === 409, `HTTP ${wrongCount.status}`);

// D7: a late sale for the PayPal seller after approval. Send reads Square
// afresh, sees a different total, and stops the whole run.
const late = { key: 'paypal', sku: 'PAY-009', price: 2500, variation: 'var-paypal-late', qty: 1, collected: 2500 };
await addItem(late);
sales.push({ orderId: 'stub-order-late', paymentId: 'stubpaylate1', variationId: late.variation, quantity: 1, unitPriceCents: 2500, collectedCents: 2500, refundedQuantity: 0, soldAt: soldAt() });
saveSales();
const stale = await post(`/payout-runs/${runId}/send`, { expectedLineCount: 3 });
ok('a total that changed since approval stops the whole send', stale.status === 409, `HTTP ${stale.status}`);
ok('...nothing reached PayPal', stubCalls('createBatch').length === 0);
run = await getRun(runId);
ok('...only the changed seller needs approving again, saying why',
  line(run, 'paypal').status === 'PENDING' && /was \$80\.00, now \$100\.00/.test(line(run, 'paypal').statusNote ?? '') &&
  line(run, 'venmo').status === 'APPROVED' && line(run, 'tiny').status === 'APPROVED',
  `${line(run, 'paypal').status}: ${line(run, 'paypal').statusNote}`);
await approve(line(run, 'paypal'));

console.log('\n── Sending ───────────────────────────────────────────────────');

const sent = await post(`/payout-runs/${runId}/send`, { expectedLineCount: 3 });
ok('Send goes through once everyone is approved', sent.status === 200, `HTTP ${sent.status}`);
const batch = stubCalls('createBatch');
ok('the send reached PayPal once, with all three', batch.length === 1 && batch[0].items.length === 3, `got ${batch.length}`);
ok('the batch is for the net amounts', batch[0]?.items.map((i) => i.amountCents).sort((a, b) => a - b).join() === '80,9600,10000',
  JSON.stringify(batch[0]?.items.map((i) => i.amountCents)));
const venmoItem = batch[0]?.items.find((i) => i.senderItemId === line(run, 'venmo').id);
ok('a Venmo payout is addressed as a user handle, without the @',
  venmoItem?.recipient.recipient_type === 'USER_HANDLE' && venmoItem?.recipient.recipient_wallet === 'Venmo' && venmoItem?.recipient.receiver === 'smoke-venmo');

run = await getRun(runId);
ok('an accepted batch leaves everyone Sending, not paid', run.lines.every((l) => l.status === 'SENDING'), run.lines.map((l) => l.status).join());
ok('...frozen, with the batch on the run', run.lines.every((l) => l.frozen) && !!run.batch?.id);
const batchId = run.batch.id;

const again = await post(`/payout-runs/${runId}/send`, { expectedLineCount: 3 });
ok('a run is sent once: a second Send is refused', again.status === 409, `HTTP ${again.status}`);
ok('...and PayPal was not asked again', stubCalls('createBatch').length === 1);
const addLate = await post(`/payout-runs/${runId}/sellers`, { sellerIds: [sellerIds.check] });
ok('a sent run takes no more sellers', addLate.status === 409, `HTTP ${addLate.status}`);

console.log('\n── PayPal’s answers ──────────────────────────────────────────');

const p = line(run, 'paypal');
await webhook('not-the-signature', itemEvent(p.id, batchId, 'SUCCESS', { transaction_id: 'TXN-FORGED' }));
run = await getRun(runId);
ok('a forged webhook changes nothing', line(run, 'paypal').status === 'SENDING');

await webhook(STUB_SIG, itemEvent(p.id, batchId, 'SUCCESS', { transaction_id: 'TXN-PAYPAL-1' }));
await webhook(STUB_SIG, itemEvent(line(run, 'venmo').id, batchId, 'UNCLAIMED'));
await webhook(STUB_SIG, itemEvent(line(run, 'tiny').id, batchId, 'FAILED', { errors: { message: 'Receiver unregistered' } }));
run = await getRun(runId);
ok('a verified webhook marks a payment paid, with its transaction ID',
  line(run, 'paypal').status === 'SENT' && line(run, 'paypal').paypal?.transactionId === 'TXN-PAYPAL-1',
  JSON.stringify(line(run, 'paypal').paypal));
ok('an unclaimed payment says so', line(run, 'venmo').status === 'UNCLAIMED');
ok('a failed payment is marked failed, with PayPal’s reason',
  line(run, 'tiny').status === 'FAILED' && line(run, 'tiny').statusNote === 'Receiver unregistered');
ok('the run stays open while a payment is unclaimed', run.status === 'OPEN');

const cancel = await post(`/payout-runs/${runId}/lines/${line(run, 'venmo').id}/cancel-payment`);
ok('an unclaimed payment can be cancelled', cancel.status === 200, `HTTP ${cancel.status}`);
ok('...at PayPal', stubCalls('cancelItem').length === 1);
run = await getRun(runId);
ok('...and is marked cancelled in the run', line(run, 'venmo').status === 'CANCELLED');
ok('the run closes itself once every payment is final', run.status === 'CLOSED' && !!run.closedAt, run.status);

console.log('\n── Paying them from another run ──────────────────────────────');

const mid = await summary();
ok('"Before you pay" lists the sellers PayPal didn’t pay',
  mid.notPaid?.map((n) => n.sellerId).sort().join() === [sellerIds.venmo, sellerIds.tiny].sort().join(), JSON.stringify(mid.notPaid));

const { id: retryId } = await post(`/swaps/${swap.id}/payout-runs`, { kind: 'PAYPAL' }).then(unwrap);
const retryChoices = await api(`${O}/payout-runs/${retryId}/choices`).then(unwrap);
ok('the picker offers them again, marked', retryChoices.length === 2 && retryChoices.every((c) => c.notPaidBefore),
  JSON.stringify(retryChoices.map((c) => [c.name, c.notPaidBefore])));
await post(`/payout-runs/${retryId}/sellers`, { sellerIds: [sellerIds.venmo, sellerIds.tiny] });
let retry = await getRun(retryId);
ok('their card says PayPal didn’t pay them before', retry.lines.every((l) => l.notPaidBefore.length === 1));
for (const l of retry.lines) await post(`/payout-runs/${retryId}/lines/${l.id}/approve`, { approved: true });

// A late sale for the check seller, after their check run closes below: picked
// up by this send's fresh read, and shown as changed since paid (D9).
const { id: checkRunId } = await post(`/swaps/${swap.id}/payout-runs`, { kind: 'CHECK' }).then(unwrap);
await post(`/payout-runs/${checkRunId}/sellers`, { sellerIds: [sellerIds.check] });
let checkRun = await getRun(checkRunId);
await post(`/payout-runs/${checkRunId}/lines/${checkRun.lines[0].id}/approve`, { approved: true });
const closeChecks = await post(`/payout-runs/${checkRunId}/close-checks`, { expectedLineCount: 1 });
ok('a check run closes and exports once everyone is approved', closeChecks.status === 200, `HTTP ${closeChecks.status}`);
checkRun = await getRun(checkRunId);
ok('...frozen, exported, and closed', checkRun.status === 'CLOSED' && checkRun.lines[0].status === 'EXPORTED' && checkRun.lines[0].frozen);
const csv = await api(`${O}/payout-runs/${checkRunId}/checks.csv`).then((r) => r.text());
const csvRow = csv.split('\r\n')[1] ?? '';
ok('the spreadsheet has payee, address, amount, memo and date',
  csvRow.startsWith('"check Smoke","12 Summit Rd","Stowe","VT","05672",64.00,"Payout smoke swap payout: 1 item",'), csvRow);

const lateCheck = { key: 'check', sku: 'PAY-010', price: 1000, variation: 'var-check-late', qty: 1, collected: 1000 };
await addItem(lateCheck);
sales.push({ orderId: 'stub-order-late-check', paymentId: 'stubpaylate2', variationId: lateCheck.variation, quantity: 1, unitPriceCents: 1000, collectedCents: 1000, refundedQuantity: 0, soldAt: soldAt() });
saveSales();

const resend = await post(`/payout-runs/${retryId}/send`, { expectedLineCount: 2 });
ok('the second run sends', resend.status === 200, `HTTP ${resend.status}`);
await post('/payout-runs/reconcile');
retry = await getRun(retryId);
ok('the sweep resolves payments no webhook arrived for, with transaction IDs',
  retry.lines.every((l) => l.status === 'SENT' && l.paypal?.transactionId), retry.lines.map((l) => l.status).join());
ok('...records the fees PayPal reported', retry.batch?.feesCents === 50, JSON.stringify(retry.batch));
ok('...and the run closes itself', retry.status === 'CLOSED');

const after = await summary();
ok('nobody is left waiting to be paid by PayPal', after.notPaid?.length === 0, JSON.stringify(after.notPaid));
const changed = after.changedSincePaid?.find((c) => c.sellerId === sellerIds.check);
ok('a late sale after the check was exported shows as owed more since paid', changed?.diffCents === 800, JSON.stringify(after.changedSincePaid));
await post(`/payout-runs/${checkRunId}/lines/${checkRun.lines[0].id}/settle`, { note: 'Second check written' });
const settled = await summary();
ok('settling it by hand clears it', !settled.changedSincePaid?.some((c) => c.sellerId === sellerIds.check));

console.log('\n── Comps (Plan 53) ───────────────────────────────────────────');

const comp = (sku, body) => post(`/swaps/${swap.id}/items/${compItemIds[sku] ?? sku}/comp`, body);
const sold = await prisma.swapItem.findFirst({ where: { swapId: swap.id, sku: 'PAY-003' }, select: { id: true } });
const soldComp = await post(`/swaps/${swap.id}/items/${sold.id}/comp`, { reason: 'OUTSIDE', note: 'smoke' });
ok('an item Square already shows sold can’t be comped', soldComp.status === 409, `HTTP ${soldComp.status}`);
const noNote = await comp('PAY-012', { reason: 'OUTSIDE', note: '' });
ok('a comp needs a note', noNote.status === 400, `HTTP ${noNote.status}`);
const otherPrice = await comp('PAY-012', { reason: 'OUTSIDE', note: 'smoke', priceCents: 3500 });
ok('a comp is always the list price', otherPrice.status === 400, `HTTP ${otherPrice.status}`);
const unpricedNoPrice = await comp('PAY-014', { reason: 'LOST', note: 'smoke' });
ok('an unpriced item needs a price to be comped', unpricedNoPrice.status === 400, `HTTP ${unpricedNoPrice.status}`);

const c1 = await comp('PAY-012', { reason: 'OUTSIDE', note: 'Paid cash at the counter' });
ok('an item with no sale in Square can be comped', c1.status === 200, `HTTP ${c1.status}`);
const c3 = await comp('PAY-014', { reason: 'NOT_FOUND', note: 'Left with a buyer', priceCents: 2500 });
ok('an unpriced item is comped at the price entered', c3.status === 200, `HTTP ${c3.status}`);
ok('...which becomes its list price', (await prisma.swapItem.findUnique({ where: { id: compItemIds['PAY-014'] } })).priceCents === 2500);
const compedTwice = await comp('PAY-012', { reason: 'OUTSIDE', note: 'again' });
ok('a comped item can’t be comped twice', compedTwice.status === 409, `HTTP ${compedTwice.status}`);

const items = await api(`${O}/swaps/${swap.id}/items?take=50`).then(unwrap);
const i12 = items.items?.find((x) => x.sku === 'PAY-012');
ok('staff see the item comped, with its reason', i12?.comp?.reason === 'OUTSIDE' && i12.comp.note === 'Paid cash at the counter', JSON.stringify(i12?.comp));
const comps = await api(`${O}/swaps/${swap.id}/comps`).then(unwrap);
ok('Adjustments → Comps lists them, with the total at list price',
  comps.comps?.length === 2 && comps.live?.count === 2 && comps.live?.totalCents === 6500, JSON.stringify(comps.live));
const withComps = await summary();
ok('the Payouts page counts them', withComps.comps?.count === 2 && withComps.comps?.totalCents === 6500, JSON.stringify(withComps.comps));

const { id: compRunId } = await post(`/swaps/${swap.id}/payout-runs`, { kind: 'CHECK' }).then(unwrap);
const compChoices = await api(`${O}/payout-runs/${compRunId}/choices`).then(unwrap);
const compSeller = compChoices.find((c) => c.sellerId === sellerIds.comp);
ok('a seller with only comped items is owed the list price less the patrol’s share',
  compSeller?.netCents === 5200 && compSeller?.items === 2, JSON.stringify(compSeller));
await post(`/payout-runs/${compRunId}/sellers`, { sellerIds: [sellerIds.comp] });
let compRun = await getRun(compRunId);
const compItem = compRun.lines[0]?.items.find((x) => x.sku === 'PAY-012');
ok('their card shows the comp where a receipt would be, with no Square link',
  compItem?.comp?.reason === 'OUTSIDE' && compItem.receipt === null && compItem.saleUrl === null, JSON.stringify(compItem));
ok('...and nobody is flagged for it', compRun.lines[0]?.flags.length === 0, JSON.stringify(compRun.lines[0]?.flags));

const c3Id = (await prisma.swapComp.findFirst({ where: { itemId: compItemIds['PAY-014'], liveKey: { not: null } } }))?.id ?? 'none';
const undoC3 = await post(`/swaps/${swap.id}/comps/${c3Id}/undo`, { note: 'Found it on the rack' });
ok('a comp can be undone before its seller is paid', undoC3.status === 200, `HTTP ${undoC3.status}`);
compRun = await getRun(compRunId);
ok('...and their total drops at once', compRun.lines[0]?.totals.netCents === 3200, JSON.stringify(compRun.lines[0]?.totals));
await post(`/payout-runs/${compRunId}/lines/${compRun.lines[0].id}/approve`, { approved: true });
const closedComp = await post(`/payout-runs/${compRunId}/close-checks`, { expectedLineCount: 1 });
ok('a comped item is paid by check like any sale', closedComp.status === 200, `HTTP ${closedComp.status}`);
const c1Id = (await prisma.swapComp.findFirst({ where: { itemId: compItemIds['PAY-012'], liveKey: { not: null } } })).id;
const undoPaid = await post(`/swaps/${swap.id}/comps/${c1Id}/undo`, { note: 'too late' });
ok('a comp can’t be undone once its seller is paid', undoPaid.status === 409, `HTTP ${undoPaid.status}`);

console.log('\n── Scanned twice, paid once ──────────────────────────────────');

const twiceOrder = sales.find((x) => x.variationId === 'var-twice-1').orderId;
const twiceItem = await prisma.swapItem.findFirst({ where: { swapId: swap.id, sku: 'PAY-020' }, select: { id: true } });
const { id: twiceRunId } = await post(`/swaps/${swap.id}/payout-runs`, { kind: 'CHECK' }).then(unwrap);
await post(`/payout-runs/${twiceRunId}/sellers`, { sellerIds: [sellerIds.twice] });
let twiceRun = await getRun(twiceRunId);
ok('a ticket rung up twice in one sale is owed once, and flags its seller',
  twiceRun.lines[0]?.totals.netCents === 1600 && twiceRun.lines[0].flags.some((f) => /PAY-020/.test(f.text)), JSON.stringify([twiceRun.lines[0]?.totals, twiceRun.lines[0]?.flags]));
const twiceBlocked = await post(`/payout-runs/${twiceRunId}/lines/${twiceRun.lines[0].id}/approve`, { approved: true });
ok('...so they can’t be approved', twiceBlocked.status === 409, `HTTP ${twiceBlocked.status}`);
const twiceKey = `twice:${twiceOrder}:${twiceItem.id}`;
const onceNoNote = await post(`/swaps/${swap.id}/sales-check/paid-once`, { key: twiceKey, orderId: twiceOrder, lineUid: 'line-8', note: ' ' });
ok('paying once needs a note', onceNoNote.status === 400, `HTTP ${onceNoNote.status}`);
const checkBefore = await api(`${O}/swaps/${swap.id}/sales-check`).then(unwrap);
const twiceLine = checkBefore.issues.find((i) => i.oversold?.sku === 'PAY-020')?.oversold.sales[0]?.lineUid;
const once = await post(`/swaps/${swap.id}/sales-check/paid-once`, { key: twiceKey, orderId: twiceOrder, lineUid: twiceLine, note: 'Customer refunded $20 by check' }).then(unwrap);
ok('paying once in Sales check is recorded', once.ok === true, JSON.stringify(once));
const checkAfter = await api(`${O}/swaps/${swap.id}/sales-check`).then(unwrap);
ok('...the issue leaves the list, decided, with its note',
  !checkAfter.issues.some((i) => i.oversold?.sku === 'PAY-020')
    && checkAfter.decided.some((d) => d.decision === 'PAID_ONCE' && d.item?.sku === 'PAY-020' && d.collectedCents === 2000 && d.note === 'Customer refunded $20 by check'),
  JSON.stringify(checkAfter.decided.filter((d) => d.decision === 'PAID_ONCE')));
twiceRun = await getRun(twiceRunId);
ok('...the seller is still owed once, and no longer flagged',
  twiceRun.lines[0]?.totals.netCents === 1600 && twiceRun.lines[0].flags.length === 0, JSON.stringify([twiceRun.lines[0]?.totals, twiceRun.lines[0]?.flags]));
const twiceApproved = await post(`/payout-runs/${twiceRunId}/lines/${twiceRun.lines[0].id}/approve`, { approved: true });
ok('...and can be approved', twiceApproved.status === 200, `HTTP ${twiceApproved.status}`);

const linesOwed = async () => (await api(`${O}/payout-runs/${twiceRunId}/choices`).then(unwrap)).find((c) => c.sellerId === sellerIds.lines);
ok('an unpriced ticket rung up at three prices in one sale is owed nothing yet', !(await linesOwed()));
const linesIssue = checkBefore.issues.find((i) => i.oversold?.sku === 'PAY-021');
ok('...Sales check lists each line with what it was rung up at',
  JSON.stringify(linesIssue?.oversold.sales.map((x) => [x.lineUid, x.unitPriceCents])) === JSON.stringify([['L10', 1000], ['L20', 2000], ['L7', 700]]),
  JSON.stringify(linesIssue?.oversold.sales));
const linesKey = `twice:stub-order-lines:${linesItemId}`;
const wrongLine = await post(`/swaps/${swap.id}/sales-check/paid-once`, { key: linesKey, orderId: 'stub-order-lines', lineUid: twiceLine, note: 'n' }).then(unwrap);
ok('...a line from another sale can’t be picked', wrongLine.ok === false, JSON.stringify(wrongLine));
const pickedLine = await post(`/swaps/${swap.id}/sales-check/paid-once`, { key: linesKey, orderId: 'stub-order-lines', lineUid: 'L20', note: 'The $10 and $7 were other tickets' }).then(unwrap);
ok('...paying once picks the $20 line', pickedLine.ok === true, JSON.stringify(pickedLine));
const linesChoice = await linesOwed();
ok('...and the seller is owed on that line, once', linesChoice?.netCents === 1600 && linesChoice.items === 1, JSON.stringify(linesChoice));
const linesDecided = (await api(`${O}/swaps/${swap.id}/sales-check`).then(unwrap)).decided.find((d) => d.item?.sku === 'PAY-021');
ok('...the other lines are what was settled outside Square', linesDecided?.decision === 'PAID_ONCE' && linesDecided.collectedCents === 1700, JSON.stringify(linesDecided));

console.log('\n── Sold in different sales, paid once ────────────────────────');

const acrossOwed = async () => (await api(`${O}/payout-runs/${twiceRunId}/choices`).then(unwrap)).find((c) => c.sellerId === sellerIds.across);
const acrossBefore = await acrossOwed();
ok('a ticket sold in two different sales is owed once, and flags its seller',
  acrossBefore?.netCents === 7120 && acrossBefore.flags.some((f) => /PAY-022/.test(f.text)), JSON.stringify(acrossBefore));
const acrossKey = `oversold:${acrossItemId}`;
ok('...Sales check offers it to pay once', (await api(`${O}/swaps/${swap.id}/sales-check`).then(unwrap)).issues.some((i) => i.key === acrossKey && i.kind === 'oversold'));
const acrossPaid = await post(`/swaps/${swap.id}/sales-check/paid-once`, { key: acrossKey, orderId: 'stub-order-across-2', lineUid: 'A2', note: 'The first sale was really another ticket' }).then(unwrap);
ok('...paying once picks the second sale', acrossPaid.ok === true, JSON.stringify(acrossPaid));
const acrossAfter = await acrossOwed();
ok('...the seller is still owed once, with no flags', acrossAfter?.netCents === 7120 && acrossAfter.flags.length === 0, JSON.stringify(acrossAfter));
const acrossDecided = (await api(`${O}/swaps/${swap.id}/sales-check`).then(unwrap)).decided.find((d) => d.item?.sku === 'PAY-022');
ok('...decided, on the sale picked, with the other sale’s $89 unpaid',
  acrossDecided?.lineUid === '#onceall:A2' && acrossDecided.orderId === 'stub-order-across-2' && acrossDecided.collectedCents === 8900, JSON.stringify(acrossDecided));

const balance = await api(`${O}/paypal-balance`).then(unwrap);
ok('the PayPal balance answers, as a number or with the reason it can’t',
  typeof balance.availableCents === 'number' || (balance.availableCents === null && typeof balance.message === 'string'),
  JSON.stringify(balance));

await finish();

async function finish() {
  console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}
