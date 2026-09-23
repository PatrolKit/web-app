/**
 * The Server health record against a real MySQL (Plan 26 §11).
 *
 * The upsert is the one piece that cannot be trusted to a fake: whether a flush
 * can lower a stored peak, and whether two flushes of one platform-wide hour
 * land as one row, are questions about MySQL, not about our code.
 */
import { setupIntegrationSuite, teardownIntegrationSuite, request } from './setup';
import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { createHash, randomBytes } from 'crypto';
import { LimitUsageService } from '../../src/common/limits/limit-usage.service';

let prisma: PrismaClient;

beforeAll(async () => {
  await setupIntegrationSuite();
  prisma = new PrismaClient();
  await prisma.$connect();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  await teardownIntegrationSuite();
});

const platform = { orgId: '', swapId: '' };
const HOUR = 3_600_000;
// Recent, deliberately: a flush also prunes past 90 days, and an hour near 1970
// would be deleted between the two flushes these tests depend on.
const thisHour = () => Math.floor(Date.now() / HOUR) * HOUR;

function usage() {
  const resolver = { resolve: async () => platform };
  return new LimitUsageService(prisma as never, resolver as never);
}

describe('LimitUsage upsert', () => {
  beforeEach(() => prisma.limitUsage.deleteMany());

  it('keeps one row per platform-wide hour, however many flushes write it', async () => {
    const svc = usage();
    const at = thisHour();
    svc.accumulate({ limitId: 'auth.login', hits: 10, refused: true, keyKind: 'ip' }, platform, true, at);
    await svc.flush();
    svc.accumulate({ limitId: 'auth.login', hits: 20, refused: true, keyKind: 'ip' }, platform, true, at + 60_000);
    await svc.flush();

    const rows = await prisma.limitUsage.findMany();
    expect(rows).toHaveLength(1);
    // The counts from both flushes, added: proof the second updated the first.
    expect(rows[0]).toMatchObject({ orgId: '', swapId: '', peakHits: 20, nearCount: 2, refusedCount: 2 });
    expect(rows[0].hourStart.getTime()).toBe(at);
  });

  it('never lowers a stored peak', async () => {
    const svc = usage();
    svc.accumulate({ limitId: 'auth.login', hits: 50, refused: true, keyKind: 'ip' }, platform, false, thisHour());
    await svc.flush();
    svc.accumulate({ limitId: 'auth.login', hits: 3, refused: true, keyKind: 'ip' }, platform, false, thisHour());
    await svc.flush();

    const rows = await prisma.limitUsage.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ peakHits: 50, refusedCount: 2 });
  });

  it('prunes rows past 90 days as it flushes', async () => {
    await prisma.limitUsage.create({
      data: {
        limitId: 'auth.login', hourStart: new Date(Date.now() - 91 * 24 * HOUR),
        peakHits: 1, limitValue: 60,
      },
    });
    const svc = usage();
    svc.accumulate({ limitId: 'auth.login', hits: 1, refused: false, keyKind: 'ip' }, platform, false, Date.now());
    await svc.flush();

    const rows = await prisma.limitUsage.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].hourStart.getTime()).toBeGreaterThan(Date.now() - 2 * HOUR);
  });
});

describe('Server health endpoints', () => {
  async function signIn(isSuperAdmin: boolean): Promise<string> {
    const user = await prisma.user.create({
      data: {
        id: createId(), email: `health-${createId()}@test.patrolkit.io`,
        firstName: 'Health', lastName: 'Check', isSuperAdmin,
      },
    });
    const rawToken = randomBytes(32).toString('hex');
    const challenge = await prisma.contactChallenge.create({
      data: {
        id: createId(), userId: user.id, channel: 'email', target: user.email!, purpose: 'login',
        codeHash: createHash('sha256').update(rawToken).digest('hex'),
        expiresAt: new Date(Date.now() + 900_000),
      },
    });
    const { body } = await request()
      .post(`/api/v1/auth/challenges/${challenge.id}/confirm`)
      .send({ code: rawToken });
    return body.data.accessToken;
  }

  it('refuse anybody who is not signed in', async () => {
    await request().get('/api/v1/admin/health/limits').expect(401);
  });

  it('refuse a signed-in user who is not a super admin', async () => {
    const token = await signIn(false);
    await request().get('/api/v1/admin/health/limits').set('Authorization', `Bearer ${token}`).expect(403);
    await request()
      .get('/api/v1/admin/health/limits/auth.login/series')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('answer a super admin with every limit', async () => {
    const token = await signIn(true);
    const { body } = await request()
      .get('/api/v1/admin/health/limits?range=7d')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(body.data.limits.map((l: { id: string }) => l.id)).toContain('codes.perDestination');
  });
});
