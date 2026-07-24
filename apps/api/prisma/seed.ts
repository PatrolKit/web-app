import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';

const prisma = new PrismaClient();

// §6 permission catalog
const PERMISSIONS = [
  { key: 'org:read', description: 'View organization details.' },
  { key: 'org:manage', description: 'Edit organization settings.' },
  { key: 'modules:manage', description: 'Enable/disable org modules.' },
  { key: 'users:read', description: 'View members of the org.' },
  { key: 'users:invite', description: 'Invite a single user (sends magic-link onboarding).' },
  { key: 'users:import', description: 'Bulk import users (the "user_admin" capability).' },
  { key: 'users:manage', description: 'Edit/disable members.' },
  { key: 'permissions:assign', description: 'Grant/revoke permissions on a membership.' },
  { key: 'devices:read', description: 'View provisioned devices.' },
  { key: 'devices:provision', description: 'Create/provision devices + rotate secrets.' },
  { key: 'devices:revoke', description: 'Revoke devices.' },
] as const;

async function main() {
  // 1. Upsert permission catalog
  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: perm.key },
      update: { description: perm.description },
      create: { id: createId(), key: perm.key, description: perm.description },
    });
  }
  console.log(`✓ ${PERMISSIONS.length} permissions seeded`);

  // 2. Upsert core module
  await prisma.moduleCatalog.upsert({
    where: { key: 'user_management' },
    update: { name: 'User Management', description: 'Core user and membership management.', isCore: true },
    create: { key: 'user_management', name: 'User Management', description: 'Core user and membership management.', isCore: true },
  });
  console.log('✓ user_management core module seeded');

  // 3. Upsert super admin
  const superAdminEmail = process.env.SEED_SUPERADMIN_EMAIL;
  if (superAdminEmail) {
    await prisma.user.upsert({
      where: { email: superAdminEmail },
      update: { isSuperAdmin: true },
      create: { id: createId(), email: superAdminEmail, name: 'Super Admin', isSuperAdmin: true },
    });
    console.log(`✓ Super admin seeded: ${superAdminEmail}`);
  } else {
    console.warn('⚠  SEED_SUPERADMIN_EMAIL not set — skipping super admin');
  }

  // 4. Demo org + owner membership (local dev only)
  if (process.env.NODE_ENV !== 'production') {
    const demoOrg = await prisma.organization.upsert({
      where: { slug: 'demo-org' },
      update: {},
      create: { id: createId(), name: 'Demo Org', slug: 'demo-org' },
    });

    if (superAdminEmail) {
      const owner = await prisma.user.findUnique({ where: { email: superAdminEmail } });
      if (owner) {
        const membership = await prisma.membership.upsert({
          where: { userId_orgId: { userId: owner.id, orgId: demoOrg.id } },
          update: {},
          create: { id: createId(), userId: owner.id, orgId: demoOrg.id },
        });

        // Grant all permissions to the owner
        const allPerms = await prisma.permission.findMany();
        for (const perm of allPerms) {
          await prisma.membershipPermission.upsert({
            where: { membershipId_permissionId: { membershipId: membership.id, permissionId: perm.id } },
            update: {},
            create: { membershipId: membership.id, permissionId: perm.id },
          });
        }

        // Enable user_management core module for demo org
        await prisma.orgModule.upsert({
          where: { orgId_moduleKey: { orgId: demoOrg.id, moduleKey: 'user_management' } },
          update: {},
          create: {
            id: createId(),
            orgId: demoOrg.id,
            moduleKey: 'user_management',
            enabled: true,
            enabledAt: new Date(),
            enabledBy: owner.id,
          },
        });

        console.log(`✓ Demo org seeded with owner membership (all permissions)`);
      }
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
