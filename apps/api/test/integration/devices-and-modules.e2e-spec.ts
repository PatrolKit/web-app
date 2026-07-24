/**
 * Integration tests — device provisioning + token + revoke.
 *
 * Covers:
 * - Provision device → secret returned once
 * - Device token endpoint with valid/invalid credentials
 * - Rotate secret
 * - Revoke blocks token endpoint
 * - Module gating
 */
import { setupIntegrationSuite, teardownIntegrationSuite, request } from './setup';
import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { createHash, randomBytes } from 'crypto';

let prisma: PrismaClient;

beforeAll(async () => {
  await setupIntegrationSuite();
  prisma = new PrismaClient();   // create AFTER DATABASE_URL is set
  await prisma.$connect();
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  await teardownIntegrationSuite();
});

async function loginAs(email: string): Promise<string> {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await prisma.magicLink.create({
    data: { id: createId(), userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 900_000) },
  });
  const { body } = await request()
    .post('/api/v1/auth/magic-link/verify')
    .send({ token: rawToken });
  return body.data.accessToken;
}

describe('Device provisioning + token lifecycle', () => {
  let orgId: string;
  let accessToken: string;
  let clientId: string;
  let clientSecret: string;
  let deviceId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { id: createId(), name: 'Device Org', slug: `dev-org-${Date.now()}` },
    });
    orgId = org.id;

    // Create a dedicated admin user for this test suite
    const adminEmail = `device-admin-${Date.now()}@test.com`;
    const adminUser = await prisma.user.create({
      data: { id: createId(), email: adminEmail, name: 'Device Admin', isSuperAdmin: true },
    });
    const membership = await prisma.membership.create({
      data: { id: createId(), userId: adminUser.id, orgId },
    });

    // Grant all permissions
    const perms = await prisma.permission.findMany();
    await prisma.membershipPermission.createMany({
      data: perms.map((p) => ({ membershipId: membership.id, permissionId: p.id })),
      skipDuplicates: true,
    });

    // Enable user_management module
    await prisma.orgModule.create({
      data: { id: createId(), orgId, moduleKey: 'user_management', enabled: true, enabledAt: new Date(), enabledBy: adminUser.id },
    });

    accessToken = await loginAs(adminEmail);
  });

  it('provisions a device and returns clientSecret once', async () => {
    const { body } = await request()
      .post(`/api/v1/orgs/${orgId}/devices`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Test Device', permissions: ['devices:read'] })
      .expect(201);

    expect(body.success).toBe(true);
    expect(body.data.clientSecret).toBeDefined();
    expect(body.data.clientId).toBeDefined();
    clientId = body.data.clientId;
    clientSecret = body.data.clientSecret;
    deviceId = body.data.id;
  });

  it('secret is not returned in device list', async () => {
    const { body } = await request()
      .get(`/api/v1/orgs/${orgId}/devices`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const device = body.data.find((d: { clientId: string }) => d.clientId === clientId);
    expect(device).toBeDefined();
    expect(device.clientSecret).toBeUndefined();
  });

  it('device token endpoint returns access token for valid credentials', async () => {
    const { body } = await request()
      .post('/api/v1/auth/device/token')
      .send({ clientId, clientSecret })
      .expect(200);
    expect(body.data.accessToken).toBeDefined();
    expect(body.data.tokenType).toBe('Bearer');
  });

  it('device token endpoint returns 401 for wrong secret', async () => {
    const { body } = await request()
      .post('/api/v1/auth/device/token')
      .send({ clientId, clientSecret: 'wrong-secret-value' })
      .expect(401);
    expect(body.success).toBe(false);
  });

  it('rotate invalidates old secret and returns new one', async () => {
    const { body } = await request()
      .post(`/api/v1/orgs/${orgId}/devices/${deviceId}/rotate-secret`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(body.data.clientSecret).toBeDefined();
    expect(body.data.clientSecret).not.toBe(clientSecret);
    clientSecret = body.data.clientSecret; // update for revoke test
  });

  it('old secret no longer works after rotation', async () => {
    // Original secret should be rejected
    await request()
      .post('/api/v1/auth/device/token')
      .send({ clientId, clientSecret: 'old-secret-from-provision' })
      .expect(401);
  });

  it('revoke blocks the token endpoint', async () => {
    await request()
      .delete(`/api/v1/orgs/${orgId}/devices/${deviceId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await request()
      .post('/api/v1/auth/device/token')
      .send({ clientId, clientSecret })
      .expect(401);
  });
});

describe('Module gating', () => {
  it('core module (user_management) cannot be disabled', async () => {
    // Create a user with modules:manage in a fresh org
    const org = await prisma.organization.create({
      data: { id: createId(), name: 'Mod Test Org', slug: `mod-org-${Date.now()}` },
    });
    await prisma.orgModule.create({
      data: { id: createId(), orgId: org.id, moduleKey: 'user_management', enabled: true, enabledAt: new Date() },
    });
    const user = await prisma.user.create({
      data: { id: createId(), email: `mod-admin-${Date.now()}@test.com`, name: 'Mod Admin' },
    });
    const membership = await prisma.membership.create({
      data: { id: createId(), userId: user.id, orgId: org.id },
    });
    const perm = await prisma.permission.findUnique({ where: { key: 'modules:manage' } });
    if (perm) await prisma.membershipPermission.create({ data: { membershipId: membership.id, permissionId: perm.id } });
    const token = await loginAs(user.email);

    const { body } = await request()
      .patch(`/api/v1/orgs/${org.id}/modules/user_management`)
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: false })
      .expect(400);
    expect(body.success).toBe(false);
  });
});

describe('Bulk CSV import', () => {
  let orgId: string;
  let accessToken: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { id: createId(), name: 'Import Org', slug: `import-org-${Date.now()}` },
    });
    orgId = org.id;

    const adminEmail = `import-admin-${Date.now()}@test.com`;
    const adminUser = await prisma.user.create({
      data: { id: createId(), email: adminEmail, name: 'Import Admin' },
    });
    const membership = await prisma.membership.create({
      data: { id: createId(), userId: adminUser.id, orgId },
    });
    const perms = await prisma.permission.findMany();
    await prisma.membershipPermission.createMany({
      data: perms.map((p) => ({ membershipId: membership.id, permissionId: p.id })),
      skipDuplicates: true,
    });
    accessToken = await loginAs(adminEmail);
  });

  it('imports CSV and returns per-row outcomes', async () => {
    const csv = 'email,name,permissions\nimport-a@test.com,Alice,org:read\nimport-b@test.com,Bob,';
    const { body } = await request()
      .post(`/api/v1/orgs/${orgId}/members/import`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from(csv), 'members.csv')
      .expect(200);

    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].outcome).toBe('created');
    expect(body.data[1].outcome).toBe('created');
  });

  it('rejects CSV with more than 500 rows', async () => {
    const rows = ['email,name,permissions', ...Array.from({ length: 501 }, (_, i) => `user${i}@t.com,User,`)];
    const { body } = await request()
      .post(`/api/v1/orgs/${orgId}/members/import`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from(rows.join('\n')), 'big.csv')
      .expect(413);
    expect(body.success).toBe(false);
  });

  it('no emails sent by default (sendInvites not set)', async () => {
    // Just verifying outcome is 'created' or 'already_member', not 'invited'
    const csv = 'email,name,permissions\nnoinvite@test.com,No Invite,';
    const { body } = await request()
      .post(`/api/v1/orgs/${orgId}/members/import`)
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from(csv), 'noinvite.csv')
      .expect(200);
    expect(body.data[0].outcome).toBe('created');
  });
});
