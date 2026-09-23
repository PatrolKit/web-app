// Limits keyed by what they protect, not by where the request came from
// (Plan 26).
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-send-limits.mjs
//
// Codes are limited per destination, so rotating addresses buys nothing: the
// sixth code to one number inside 15 minutes is refused whatever address asks.
// A sign-in over that limit must look exactly like one for somebody who does
// not exist. Two people signed in behind one address — a venue's wifi — each
// get their own bucket. And the Server health page has to show what happened.
//
// Sends from loopback with an X-Forwarded-For header, which is what Caddy does.
// The numbers are inside +1 555-01xx, reserved for fictional use: on a host with
// delivery switched on, a send fails at the carrier rather than reaching anyone.

import { PrismaClient } from '@prisma/client';
import {
  smokeOrg, smokeStaff, smokeSession, smokeSuperAdmin, dropSmokeAdmin,
} from './_fixture.mjs';

const prisma = new PrismaClient();
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};
const body = async (r) => { const b = await r.json(); return b?.success && 'data' in b ? b.data : b; };
const unwrap = body;
const addr = () => `203.0.113.${Math.floor(Math.random() * 250) + 2}`;

const PHONE = '+15550199061';
const NOBODY = '+15550199062';

// ─── Fixtures ────────────────────────────────────────────────────────────────
const org = await smokeOrg(prisma);
await prisma.skiSwap.deleteMany({ where: { orgId: org.id, title: 'Send limits swap' } });
await prisma.checkinStation.deleteMany({ where: { orgId: org.id, name: 'Send limits station' } });
await prisma.user.deleteMany({ where: { phone: { in: [PHONE, NOBODY] } } });

const swap = await prisma.skiSwap.create({
  data: {
    orgId: org.id, title: 'Send limits swap', squareCategoryId: 'smoke',
    skuPrefix: 'SLS', active: true, activeSkuPrefix: 'SLS',
  },
});
const station = await prisma.checkinStation.create({
  data: { orgId: org.id, name: 'Send limits station', code: 'L' },
});

const register = (phone, from) =>
  fetch(`${BASE}/public/checkin/${swap.id}/register?station=${station.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': from },
    body: JSON.stringify({ phone }),
  });

// ─── One destination, many addresses ─────────────────────────────────────────
const statuses = [];
let refusal;
for (let i = 0; i < 6; i++) {
  const res = await register(PHONE, addr());
  statuses.push(res.status);
  if (res.status === 429) refusal = await res.json();
}
ok('five codes to one number go, each from a different address',
  statuses.slice(0, 5).every((s) => s === 200), statuses.join(' '));
ok('...and the sixth is refused whatever address asks', statuses[5] === 429, statuses.join(' '));
ok('...saying why, in a way a client can act on', refusal?.code === 'TOO_MANY_CODES', JSON.stringify(refusal));

// ─── A limited sign-in is indistinguishable ──────────────────────────────────
const login = (phone) =>
  fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': addr() },
    body: JSON.stringify({ phone }),
  });
const limitedRes = await login(PHONE);
const unknownRes = await login(NOBODY);
const limited = await body(limitedRes);
const unknown = await body(unknownRes);
ok('a limited sign-in answers like one for nobody at all',
  limitedRes.status === unknownRes.status &&
    JSON.stringify(Object.keys(limited).sort()) === JSON.stringify(Object.keys(unknown).sort()) &&
    limited.channel === unknown.channel,
  `${JSON.stringify(limited)} vs ${JSON.stringify(unknown)}`);
ok('...and stores nothing, so nothing was sent',
  !(await prisma.contactChallenge.findUnique({ where: { id: limited.challengeId ?? '' } })));

// ─── Only numbers we can text ────────────────────────────────────────────────
const abroad = await register('+442071234567', addr());
const abroadBody = await abroad.json();
ok('a number outside the US and Canada is refused, with a way forward',
  abroad.status === 400 && abroadBody.code === 'CANNOT_TEXT' && /email/i.test(abroadBody.error),
  `HTTP ${abroad.status} ${JSON.stringify(abroadBody)}`);

// ─── Signed in, behind one address ───────────────────────────────────────────
const { user: staff } = await smokeStaff(prisma, org, ['ski_swap:manage']);
const admin = await smokeSuperAdmin(prisma);
const venue = addr();
const tokenA = await smokeSession(prisma, BASE, staff, unwrap);
const tokenB = await smokeSession(prisma, BASE, admin, unwrap);
const me = (token) =>
  fetch(`${BASE}/me`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': venue } });
await me(tokenA);
const a = await me(tokenA);
const b = await me(tokenB);
ok('two people signed in behind one address each get their own bucket',
  b.headers.get('x-ratelimit-limit') === '600' &&
    Number(a.headers.get('x-ratelimit-remaining')) === Number(b.headers.get('x-ratelimit-remaining')) - 1,
  `A ${a.headers.get('x-ratelimit-remaining')}/${a.headers.get('x-ratelimit-limit')}, ` +
    `B ${b.headers.get('x-ratelimit-remaining')}/${b.headers.get('x-ratelimit-limit')}`);

// ─── The Server health page saw it ───────────────────────────────────────────
const health = await fetch(`${BASE}/admin/health/limits?range=24h`, {
  headers: { authorization: `Bearer ${tokenB}` },
}).then(unwrap);
const codes = health.limits?.find((l) => l.id === 'codes.perDestination');
ok('the health page counts the refused code', (codes?.refusedCount ?? 0) >= 1, JSON.stringify(codes));
// Other swaps may have come as close today, so look for this one among the
// places that came closest rather than expecting it to be the only one.
const series = await fetch(`${BASE}/admin/health/limits/codes.perDestination/series?range=24h`, {
  headers: { authorization: `Bearer ${tokenB}` },
}).then(unwrap);
const here = series.top?.find((p) => p.swap?.id === swap.id);
ok('...and says it was this swap, at the limit', here?.percent === 100 && here?.refusedCount >= 1,
  JSON.stringify(here ?? series.top));

const staffHealth = await fetch(`${BASE}/admin/health/limits`, { headers: { authorization: `Bearer ${tokenA}` } });
ok('...and is closed to anybody who is not a super admin', staffHealth.status === 403, `HTTP ${staffHealth.status}`);

// ─── Cleanup ─────────────────────────────────────────────────────────────────
await prisma.user.deleteMany({ where: { phone: { in: [PHONE, NOBODY] } } });
await prisma.checkinStation.delete({ where: { id: station.id } });
await prisma.skiSwap.delete({ where: { id: swap.id } });
await dropSmokeAdmin(prisma);
await prisma.$disconnect();

console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
