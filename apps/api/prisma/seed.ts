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
  // Ski Swap module permissions
  { key: 'ski_swap:report', description: 'View ski swap items, stats, and seller records.' },
  { key: 'ski_swap:manage', description: 'Read/write ski swap items and sellers.' },
  { key: 'ski_swap:admin', description: 'Manage ski swaps and configure Square credentials.' },
  { key: 'business_seller', description: 'Self-service access to own consignment items in ski swaps.' },
  // Time Tracking module permissions
  { key: 'time_tracking:report', description: 'View time tracking records and reports.' },
  { key: 'time_tracking:manage', description: 'Create and edit time tracking entries.' },
  { key: 'time_tracking:admin', description: 'Administer time tracking settings and all entries.' },
  // Signage module permissions
  { key: 'signage:report', description: 'View signage displays and message history.' },
  { key: 'signage:manage', description: 'Create and publish messages to signage displays.' },
  { key: 'signage:admin', description: 'Administer signage displays and settings.' },
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

  // 2. Upsert modules
  await prisma.moduleCatalog.upsert({
    where: { key: 'user_management' },
    update: { name: 'User Management', description: 'Core user and membership management.', isCore: true },
    create: { key: 'user_management', name: 'User Management', description: 'Core user and membership management.', isCore: true },
  });
  await prisma.moduleCatalog.upsert({
    where: { key: 'ski_swap' },
    update: { name: 'Ski Swap', description: 'Consignment ski swap management powered by Square POS.' },
    create: { key: 'ski_swap', name: 'Ski Swap', description: 'Consignment ski swap management powered by Square POS.', isCore: false },
  });
  await prisma.moduleCatalog.upsert({
    where: { key: 'time_tracking' },
    update: { name: 'Time Tracking', description: 'Track and report on time entries across your organization.' },
    create: { key: 'time_tracking', name: 'Time Tracking', description: 'Track and report on time entries across your organization.', isCore: false },
  });
  await prisma.moduleCatalog.upsert({
    where: { key: 'signage' },
    update: { name: 'Signage', description: 'Manage smart displays in patrol rooms for distributing notifications and messages.' },
    create: { key: 'signage', name: 'Signage', description: 'Manage smart displays in patrol rooms for distributing notifications and messages.', isCore: false },
  });
  console.log('✓ modules seeded');

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

        // Enable ski_swap for dev so the module is accessible out of the box
        await prisma.orgModule.upsert({
          where: { orgId_moduleKey: { orgId: demoOrg.id, moduleKey: 'ski_swap' } },
          update: {},
          create: {
            id: createId(),
            orgId: demoOrg.id,
            moduleKey: 'ski_swap',
            enabled: true,
            enabledAt: new Date(),
            enabledBy: owner.id,
          },
        });

        console.log(`✓ Demo org seeded with owner membership (all permissions)`);

        // Dev users with escalating ski-swap permission levels for testing
        const swapUsers = [
          { email: 'swap-reporter@example.com', name: 'Swap Reporter', perms: ['ski_swap:report'] },
          { email: 'swap-manager@example.com',  name: 'Swap Manager',  perms: ['ski_swap:report', 'ski_swap:manage'] },
          { email: 'swap-admin@example.com',    name: 'Swap Admin',    perms: ['ski_swap:report', 'ski_swap:manage', 'ski_swap:admin'] },
        ] as const;

        for (const u of swapUsers) {
          const devUser = await prisma.user.upsert({
            where: { email: u.email },
            update: {},
            create: { id: createId(), email: u.email, name: u.name },
          });
          const devMembership = await prisma.membership.upsert({
            where: { userId_orgId: { userId: devUser.id, orgId: demoOrg.id } },
            update: {},
            create: { id: createId(), userId: devUser.id, orgId: demoOrg.id },
          });
          for (const permKey of u.perms) {
            const perm = await prisma.permission.findUniqueOrThrow({ where: { key: permKey } });
            await prisma.membershipPermission.upsert({
              where: { membershipId_permissionId: { membershipId: devMembership.id, permissionId: perm.id } },
              update: {},
              create: { membershipId: devMembership.id, permissionId: perm.id },
            });
          }
        }
        console.log(`✓ Ski-swap dev users seeded (reporter / manager / admin)`);

        // Enable time_tracking for dev so the TimeClock module works out of the box
        await prisma.orgModule.upsert({
          where: { orgId_moduleKey: { orgId: demoOrg.id, moduleKey: 'time_tracking' } },
          update: {},
          create: {
            id: createId(),
            orgId: demoOrg.id,
            moduleKey: 'time_tracking',
            enabled: true,
            enabledAt: new Date(),
            enabledBy: owner.id,
          },
        });

        // Demo resorts + roster so a TimeClock iPad has something to bind to
        const resorts = [
          { name: 'North Lodge', street: '1 Summit Rd', city: 'Lake Placid', state: 'NY', zip: '12946', timeZone: 'America/New_York' },
          { name: 'South Peak', street: '200 Base Lodge Way', city: 'Killington', state: 'VT', zip: '05751', timeZone: 'America/New_York' },
        ] as const;
        for (const r of resorts) {
          const existing = await prisma.resort.findFirst({
            where: { orgId: demoOrg.id, name: r.name, deletedAt: null },
          });
          if (!existing) {
            await prisma.resort.create({ data: { id: createId(), orgId: demoOrg.id, ...r } });
          }
        }

        await prisma.timeClockSettings.upsert({
          where: { orgId: demoOrg.id },
          update: {},
          create: { id: createId(), orgId: demoOrg.id },
        });

        const patrollers = [
          { firstName: 'Jane',    lastName: 'Doe',       nspId: '100001', patrolLevel: 'Senior' },
          { firstName: 'John',    lastName: 'Smith',     nspId: '100002', patrolLevel: 'Basic' },
          { firstName: 'Maria',   lastName: 'Garcia',    nspId: '100003', patrolLevel: 'Certified' },
          { firstName: 'Chen',    lastName: 'Wei',       nspId: '100004', patrolLevel: 'Candidate' },
          { firstName: 'Aisha',   lastName: 'Patel',     nspId: '100005', patrolLevel: 'Senior' },
          { firstName: 'Tom',     lastName: 'Anderson',  nspId: '100006', patrolLevel: 'Basic' },
        ] as const;
        for (const pt of patrollers) {
          await prisma.patroller.upsert({
            where: { orgId_nspId: { orgId: demoOrg.id, nspId: pt.nspId } },
            update: {},
            create: {
              id: createId(),
              orgId: demoOrg.id,
              firstName: pt.firstName,
              lastName: pt.lastName,
              nspId: pt.nspId,
              patrolLevel: pt.patrolLevel,
            },
          });
        }
        console.log(`✓ Time-clock demo resorts, settings, and roster seeded`);

        // Dev users with escalating time-tracking permission levels
        const timeUsers = [
          { email: 'time-reporter@example.com', name: 'Time Reporter', perms: ['time_tracking:report'] },
          { email: 'time-manager@example.com',  name: 'Time Manager',  perms: ['time_tracking:report', 'time_tracking:manage'] },
          { email: 'time-admin@example.com',    name: 'Time Admin',    perms: ['time_tracking:report', 'time_tracking:manage', 'time_tracking:admin'] },
        ] as const;

        for (const u of timeUsers) {
          const devUser = await prisma.user.upsert({
            where: { email: u.email },
            update: {},
            create: { id: createId(), email: u.email, name: u.name },
          });
          const devMembership = await prisma.membership.upsert({
            where: { userId_orgId: { userId: devUser.id, orgId: demoOrg.id } },
            update: {},
            create: { id: createId(), userId: devUser.id, orgId: demoOrg.id },
          });
          for (const permKey of u.perms) {
            const perm = await prisma.permission.findUniqueOrThrow({ where: { key: permKey } });
            await prisma.membershipPermission.upsert({
              where: { membershipId_permissionId: { membershipId: devMembership.id, permissionId: perm.id } },
              update: {},
              create: { membershipId: devMembership.id, permissionId: perm.id },
            });
          }
        }
        console.log(`✓ Time-tracking dev users seeded (reporter / manager / admin)`);
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
