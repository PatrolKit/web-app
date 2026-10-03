// A verified contact reaches a delta-syncing iPad, and a changed one is unverified.
//
// The iPads sync sellers with `?updatedSince=`, which reads Membership.updatedAt.
// Verifying a contact writes only the user, so confirming one has to move every
// membership's watermark too, or no delta ever carries it.
//
//   SMOKE_BASE=https://patrolkit.io/api/v1 node apps/api/scripts/smoke-verify-delta.mjs

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

const EMAIL = 'verify-delta-seller@patrolkit.invalid';
await prisma.user.deleteMany({
  where: { OR: [{ email: EMAIL }, { verifiedEmail: EMAIL }, { email: 'verify-delta-new@patrolkit.invalid' }] },
});

const org = await smokeOrg(prisma);
const { user: staffUser } = await smokeStaff(prisma, org, ['ski_swap:report', 'ski_swap:manage', 'ski_swap:admin']);
const SH = { authorization: `Bearer ${await smokeSession(prisma, BASE, staffUser, unwrap)}` };

// A seller whose row last changed well before the cursor.
const long_ago = new Date(Date.now() - 10 * 60_000);
const seller = await prisma.user.create({ data: { id: createId(), email: EMAIL, firstName: 'Verify', lastName: 'Delta' } });
const membership = await prisma.membership.create({
  data: { id: createId(), userId: seller.id, orgId: org.id, updatedAt: long_ago },
});
const profile = await prisma.sellerProfile.create({ data: { id: createId(), membershipId: membership.id } });
await prisma.membership.update({ where: { id: membership.id }, data: { updatedAt: long_ago } });

const cursor = new Date(Date.now() - 1000).toISOString();
// A refusal must not read as an empty delta, or the first check passes on it.
const delta = async () => {
  const r = await fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers?updatedSince=${encodeURIComponent(cursor)}`, { headers: SH }).then(unwrap);
  if (!Array.isArray(r?.sellers)) throw new Error(`The sellers delta failed: ${JSON.stringify(r).slice(0, 200)}`);
  return r.sellers;
};

ok('before verifying, the seller is not in the delta', !(await delta()).some((s) => s.id === profile.id));

// The verification link's challenge, with a code we know. Only delivery is
// skipped; the confirm endpoint and its writes are the real thing.
const challenge = await prisma.contactChallenge.create({
  data: {
    id: createId(), userId: seller.id, channel: 'email', target: EMAIL, purpose: 'verify',
    codeHash: createHash('sha256').update(SMOKE_CODE).digest('hex'),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  },
});
const confirmed = await fetch(`${BASE}/auth/challenges/${challenge.id}/confirm`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: SMOKE_CODE }),
});
ok('the verification link is confirmed', confirmed.ok, `HTTP ${confirmed.status}`);

const after = (await delta()).find((s) => s.id === profile.id);
ok('after verifying, a delta from before carries the seller', !!after);
ok('...with the email verified', !!after?.emailVerifiedAt, String(after?.emailVerifiedAt));

// Staff correcting the email unverifies it: the new address is unproven, and
// the old one is no longer where receipts and payouts go.
const changed = await fetch(`${BASE}/orgs/${org.id}/ski-swap/sellers/${profile.id}`, {
  method: 'PATCH', headers: { ...SH, 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'verify-delta-new@patrolkit.invalid' }),
});
ok('staff can change the verified email', changed.ok, `HTTP ${changed.status}`);
const unverified = (await delta()).find((s) => s.id === profile.id);
ok('...which unverifies it, and a delta says so',
  unverified?.email === 'verify-delta-new@patrolkit.invalid' && unverified?.emailVerifiedAt === null,
  JSON.stringify({ email: unverified?.email, emailVerifiedAt: unverified?.emailVerifiedAt }));
const row = await prisma.user.findUnique({ where: { id: seller.id }, select: { verifiedEmail: true } });
ok('...and receipts no longer go to the old address', row?.verifiedEmail === null, String(row?.verifiedEmail));

await prisma.user.delete({ where: { id: seller.id } });
console.log(failed ? `${failed} failed` : 'All assertions passed');
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
