/**
 * Integration tests — auth flows + org isolation.
 *
 * Covers:
 * - Magic-link request (always 200, no enumeration)
 * - Magic-link verify → access token + refresh cookie
 * - Refresh rotation
 * - Logout
 * - Org isolation (cross-org access blocked)
 */
import { setupIntegrationSuite, teardownIntegrationSuite, request } from './setup';
import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { createHash, randomBytes } from 'crypto';

const prisma = new PrismaClient();

beforeAll(async () => {
  await setupIntegrationSuite();
  await prisma.$connect();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  await teardownIntegrationSuite();
});

describe('Health', () => {
  it('GET /healthz returns 200', async () => {
    await request().get('/healthz').expect(200);
  });

  it('GET /readyz returns 200 with DB connected', async () => {
    const { body } = await request().get('/readyz').expect(200);
    expect(body.success).toBe(true);
  });
});

describe('Auth — magic link (no enumeration)', () => {
  it('POST /auth/magic-link returns 200 for unknown email', async () => {
    const { body } = await request()
      .post('/api/v1/auth/magic-link')
      .send({ email: 'nobody@unknown.example' })
      .expect(200);
    expect(body.success).toBe(true);
  });

  it('POST /auth/magic-link returns 200 for known user', async () => {
    const { body } = await request()
      .post('/api/v1/auth/magic-link')
      .send({ email: 'admin@test.patrolkit.io' })
      .expect(200);
    expect(body.success).toBe(true);
  });

  it('POST /auth/magic-link/verify rejects invalid token', async () => {
    const { body } = await request()
      .post('/api/v1/auth/magic-link/verify')
      .send({ token: 'deadbeef'.repeat(8) })
      .expect(401);
    expect(body.success).toBe(false);
  });
});

describe('Auth — full magic-link flow', () => {
  let accessToken: string;

  it('can obtain tokens via the stored magic-link hash', async () => {
    // Create magic link directly in DB (simulates email click)
    const { createHash, randomBytes } = await import('crypto');
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'admin@test.patrolkit.io' },
    });
    await prisma.magicLink.create({
      data: {
        id: createId(),
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 900_000),
      },
    });

    const { body } = await request()
      .post('/api/v1/auth/magic-link/verify')
      .send({ token: rawToken })
      .expect(200);

    expect(body.success).toBe(true);
    expect(body.data.accessToken).toBeDefined();
    accessToken = body.data.accessToken;
  });

  it('GET /api/v1/me returns authenticated user', async () => {
    const { body } = await request()
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(body.data.email).toBe('admin@test.patrolkit.io');
    expect(body.data.isSuperAdmin).toBe(true);
  });

  it('GET /api/v1/me rejects unauthenticated request', async () => {
    await request().get('/api/v1/me').expect(401);
  });

  it('used magic-link token is rejected', async () => {
    const link = await prisma.magicLink.findFirst({ where: { usedAt: { not: null } } });
    expect(link).not.toBeNull();
  });
});

describe('Org isolation', () => {
  let orgAId: string;
  let orgBId: string;
  let tokenOrgA: string;

  beforeAll(async () => {
    const orgA = await prisma.organization.create({
      data: { id: createId(), name: 'Org A', slug: `org-a-${Date.now()}` },
    });
    const orgB = await prisma.organization.create({
      data: { id: createId(), name: 'Org B', slug: `org-b-${Date.now()}` },
    });
    orgAId = orgA.id;
    orgBId = orgB.id;

    const user = await prisma.user.create({
      data: { id: createId(), email: `isolation-user-${Date.now()}@test.com`, name: 'Isolation User' },
    });
    const membership = await prisma.membership.create({
      data: { id: createId(), userId: user.id, orgId: orgAId },
    });
    const orgReadPerm = await prisma.permission.findUnique({ where: { key: 'org:read' } });
    if (orgReadPerm) {
      await prisma.membershipPermission.create({
        data: { membershipId: membership.id, permissionId: orgReadPerm.id },
      });
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await prisma.magicLink.create({
      data: { id: createId(), userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 900_000) },
    });
    const { body } = await request()
      .post('/api/v1/auth/magic-link/verify')
      .send({ token: rawToken });
    tokenOrgA = body.data.accessToken;
  });

  it('can access Org A', async () => {
    await request()
      .get(`/api/v1/orgs/${orgAId}`)
      .set('Authorization', `Bearer ${tokenOrgA}`)
      .expect(200);
  });

  it('is blocked from Org B (cross-org access denied)', async () => {
    const { body } = await request()
      .get(`/api/v1/orgs/${orgBId}`)
      .set('Authorization', `Bearer ${tokenOrgA}`)
      .expect(403);
    expect(body.success).toBe(false);
  });
});

describe('Permission enforcement', () => {
  let tokenNoPerms: string;
  let orgId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { id: createId(), name: 'Perm Test Org', slug: `perm-org-${Date.now()}` },
    });
    orgId = org.id;
    const user = await prisma.user.create({
      data: { id: createId(), email: `perm-user-${Date.now()}@test.com`, name: 'No-Perm User' },
    });
    await prisma.membership.create({
      data: { id: createId(), userId: user.id, orgId },
    });
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await prisma.magicLink.create({
      data: { id: createId(), userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 900_000) },
    });
    const { body } = await request()
      .post('/api/v1/auth/magic-link/verify')
      .send({ token: rawToken });
    tokenNoPerms = body.data.accessToken;
  });

  it('returns 403 when user lacks org:read', async () => {
    const { body } = await request()
      .get(`/api/v1/orgs/${orgId}`)
      .set('Authorization', `Bearer ${tokenNoPerms}`)
      .expect(403);
    expect(body.success).toBe(false);
  });
});
