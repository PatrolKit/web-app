// A 62 × 100 receipt is one page for an ordinary seller, and spills only when
// the item list does. Walks the real queue, because the change that makes this
// work is split across the renderer, the recipe and the enqueue — a renderer
// test alone would pass with the masthead job still being queued.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-tall-receipt.mjs
//
// Its seller is deleted before each run, codes and all, so back-to-back runs do
// not meet the limit of five codes per destination in 15 minutes.

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { smokeOrg, forceChallengeCode, textingOnForRun } from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';
const unwrap = async (r) => { const b = await r.json(); return b && b.success && 'data' in b ? b.data : b; };

// Sellers here sign up by phone, which needs texting on (Plan 29). Put back after.
const restoreTexting = await textingOnForRun(prisma, BASE, unwrap);
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const org = await smokeOrg(prisma);
const SEED = 'tall-receipt-smoke';
// Idempotency keys are scoped to the swap, and this script makes a new one each
// run — but a fixed key would still replay a previous run's response.
const RUN = Math.random().toString(36).slice(2, 10);
const PHONE = '+15550199077';

const priorSwaps = await prisma.skiSwap.findMany({ where: { orgId: org.id, title: 'Tall receipt swap' }, select: { id: true } });
for (const s of priorSwaps) {
  await prisma.printJob.deleteMany({ where: { swapId: s.id } });
  await prisma.swapItem.deleteMany({ where: { swapId: s.id } });
}
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Tall receipt swap' } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'Tall station' } });
await prisma.swapPrinter.deleteMany({ where: { orgId: org.id, name: 'Tall printer' } });
await prisma.device.deleteMany({ where: { clientId: `${SEED}-bridge` } });
const priorUser = await prisma.user.findFirst({ where: { phone: PHONE } });
if (priorUser) await prisma.user.delete({ where: { id: priorUser.id } });

const swap = await prisma.skiSwap.create({
  data: { orgId: org.id, slug: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, title: 'Tall receipt swap', squareCategoryId: 'tall',
          skuPrefix: 'TRS', active: true, activeSkuPrefix: 'TRS' },
});
const device = await prisma.device.create({
  data: { orgId: org.id, name: 'Tall bridge', clientId: `${SEED}-bridge`,
          secretHash: await argon2.hash('smoke-secret'), role: 'ski_swap.print_bridge' },
});
// The whole point: an M221 on 62 × 100 stock, reached through the station's bridge.
await prisma.swapPrinter.create({
  data: { orgId: org.id, name: 'Tall printer', bluetoothName: 'M221-TR', bridgeDeviceId: device.id,
          model: 'm221', paperSize: '62x100',
          marginTop: 16, marginBottom: 16, marginLeft: 16, marginRight: 16 },
});
const station = await prisma.checkinStation.create({
  data: { orgId: org.id, name: 'Tall station', code: 'T', bridgeDeviceId: device.id },
});

const category = await prisma.taxonomyNode.findFirst({ where: { kind: 'CATEGORY', label: 'Skis' } });
if (!category) { console.log('FAIL  no Skis category seeded'); process.exit(1); }

// ─── One seller, three items ────────────────────────────────────────────────
const reg = await fetch(`${BASE}/public/checkin/${swap.id}/register?station=${station.id}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ phone: PHONE.replace('+1', '') }),
}).then(unwrap);
const code = reg.devCode ?? await forceChallengeCode(prisma, reg.challengeId);
const session = await fetch(`${BASE}/auth/challenges/${reg.challengeId}/confirm`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code }),
}).then(unwrap);
const H = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' };

await fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/join`, {
  method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, stationId: station.id }),
}).then(unwrap);
await fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me`, {
  method: 'PATCH', headers: H,
  body: JSON.stringify({ firstName: 'Tall', lastName: 'Tester', street: '1 Summit Rd',
                         city: 'Stowe', state: 'VT', zip: '05672' }),
});
// No `name`: Plan 19 derives it from the category, and the schema is strict.
const addItem = (i) =>
  fetch(`${BASE}/orgs/${org.id}/ski-swap/seller/me/items`, {
    method: 'POST', headers: { ...H, 'idempotency-key': `${SEED}-${RUN}-${i}` },
    body: JSON.stringify({ swapId: swap.id, categoryId: category.id,
                           priceCents: 4500 + i * 500, quantity: 1, stationId: station.id }),
  }).then(unwrap);

const ITEMS = 3;
for (let i = 0; i < ITEMS; i++) await addItem(i);

// Asserted, not assumed. Every check below is about how a list of items
// paginates, so a silently empty list would make all of them pass by saying
// nothing — an empty receipt is one page too.
const madeFirst = await prisma.swapItem.count({ where: { swapId: swap.id } });
ok('the seller actually has items to put on a receipt', madeFirst === ITEMS, `${madeFirst}`);

await prisma.printJob.deleteMany({ where: { swapId: swap.id, kind: 'item' } });
const finish = await fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/finish`, {
  method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, stationId: station.id }),
});
ok('check-in finishes on a 62 × 100 station', finish.ok, String(finish.status));
const finished = await finish.json().then((b) => b.data ?? b);
// `receiptPages` counts labels queued. On this tier there is no masthead label,
// so a `+ 1` here would promise one the bridge never receives.
ok('it reports the labels it actually queued', finished.receiptPages === 1,
   JSON.stringify(finished));

const jobs = await prisma.printJob.findMany({
  where: { swapId: swap.id, kind: { in: ['receipt_header', 'receipt_items'] } },
  orderBy: { seq: 'asc' }, select: { kind: true, seq: true, params: true },
});

ok('no separate masthead label is queued',
   jobs.every((j) => j.kind !== 'receipt_header'),
   jobs.map((j) => j.kind).join(','));
ok('three items are one page, not two',
   jobs.length === 1 && jobs[0].kind === 'receipt_items',
   `${jobs.length} job(s): ${jobs.map((j) => `${j.kind}#${j.seq}`).join(' ')}`);
ok('the one job is page zero — nothing left a gap where the header used to be',
   jobs[0]?.seq === 0 && (jobs[0]?.params?.page ?? 0) === 0,
   JSON.stringify(jobs[0] ?? null));

// ─── The same seller, enough items to spill ─────────────────────────────────
for (let i = ITEMS; i < 24; i++) await addItem(i);
const madeAll = await prisma.swapItem.count({ where: { swapId: swap.id } });
ok('and enough of them to run past one page', madeAll === 24, `${madeAll}`);
await prisma.printJob.deleteMany({ where: { swapId: swap.id } });
await fetch(`${BASE}/orgs/${org.id}/ski-swap/checkin/finish`, {
  method: 'POST', headers: H, body: JSON.stringify({ swapId: swap.id, stationId: station.id }),
});
const many = await prisma.printJob.findMany({
  where: { swapId: swap.id, kind: 'receipt_items' }, orderBy: { seq: 'asc' },
  select: { seq: true, params: true },
});
ok('twenty-four items spill onto more pages', many.length > 1, `${many.length} pages`);
ok('the pages are numbered from zero, in order',
   many.every((j, i) => j.seq === i && (j.params?.page ?? -1) === i),
   many.map((j) => `${j.seq}:${j.params?.page}`).join(' '));

await restoreTexting();
await prisma.$disconnect();
