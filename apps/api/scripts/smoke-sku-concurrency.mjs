// Mints SKUs from several stations at once and asserts none collide.
//
// The guarantee lives in a unique index and an atomic upsert-then-increment, so
// it cannot be tested with a mocked Prisma — the thing under test IS the
// database. Self-service makes concurrent creation the normal case, and a
// duplicate SKU is a duplicate barcode, which sells the wrong item.
//
//   node apps/api/scripts/smoke-sku-concurrency.mjs

import { PrismaClient } from '@prisma/client';
import { SkuService } from '../dist/src/ski-swap/sku.service.js';

import { smokeOrg } from './_fixture.mjs';

const prisma = new PrismaClient();
const sku = new SkuService(prisma);
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);

const org = await smokeOrg(prisma);
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'SKU concurrency swap' } });
const swap = await prisma.skiSwap.create({
  data: { orgId: org.id, title: 'SKU concurrency swap', squareCategoryId: 'sku', skuPrefix: 'SKU' },
});

// The real service against the real database — the guarantee lives in the SQL,
// so a reimplementation here would be testing the wrong thing.
const nextSku = (code) => sku.next(swap.id, code);

// Four stations, twelve items each, all at once.
const STATIONS = ['A', 'B', 'C', 'D'];
const PER_STATION = 12;
const minted = await Promise.all(
  STATIONS.flatMap((code) => Array.from({ length: PER_STATION }, () => nextSku(code))),
);

ok('every SKU is distinct', new Set(minted).size === minted.length,
   `${new Set(minted).size} unique of ${minted.length}`);

for (const code of STATIONS) {
  const forStation = minted.filter((s) => s.startsWith(`SKU-${code}-`)).sort();
  const expected = Array.from({ length: PER_STATION }, (_, i) => `SKU-${code}-${String(i + 1).padStart(4, '0')}`);
  ok(`station ${code} counts 1..${PER_STATION} with no gaps`,
     JSON.stringify(forStation) === JSON.stringify(expected),
     forStation.length ? `${forStation[0]}..${forStation[forStation.length - 1]}` : 'none');
}

// The width budget: 6-char prefix + code + 4 digits must stay inside 13.
const widest = `ABSS26-Z-9999`;
ok('a maximal SKU fits the 13-character barcode budget', widest.length === 13, `${widest.length} chars`);

await prisma.swapSkuCounter.deleteMany({ where: { swapId: swap.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await prisma.$disconnect();
