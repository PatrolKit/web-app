import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';

const prisma = new PrismaClient();

/**
 * Dev fixtures use unroutable contacts by design: @example.com is reserved by
 * RFC 2606, and +1555xxxxxxx is the reserved fictional range. Even if outbound
 * notifications were mistakenly enabled, nothing can reach a real person.
 */
async function upsertPerson(data: {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  nspId?: string;
  patrolLevel?: string;
  isSuperAdmin?: boolean;
}) {
  const existing = data.email
    ? await prisma.user.findFirst({ where: { email: data.email } })
    : data.nspId
      ? await prisma.user.findUnique({ where: { nspId: data.nspId } })
      : null;

  if (existing) {
    return prisma.user.update({ where: { id: existing.id }, data });
  }
  return prisma.user.create({ data: { id: createId(), ...data } });
}

async function upsertMembership(userId: string, orgId: string) {
  return prisma.membership.upsert({
    where: { userId_orgId: { userId, orgId } },
    update: { deletedAt: null },
    create: { id: createId(), userId, orgId, updatedAt: new Date() },
  });
}

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
  // Ski Swap module permissions
  { key: 'ski_swap:report', description: 'View ski swap items, stats, and seller records.' },
  { key: 'ski_swap:manage', description: 'Read/write ski swap items and sellers.' },
  { key: 'ski_swap:admin', description: 'Manage ski swaps and configure Square credentials.' },
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

  // 2b. Device bootstrap: where the fleet installs from, and what each role runs.
  //
  // Platform-scoped and not tied to any org. The repository identifiers are the
  // real deployed ones (APT_REPO_PLAN §7a) — in particular the key fingerprint,
  // which the server cannot validate and which every device silently rejects if
  // it is wrong.
  const aptRepo = await prisma.bootstrapRepository.upsert({
    where: { name: 'patrolkit' },
    update: {
      uri: 'https://apt.patrolkit.io',
      suite: 'trixie',
      components: 'main',
      arch: 'arm64',
      signedByKeyId: 'A267DE35610137808C467188B7B81B42B960F4F0',
    },
    create: {
      id: createId(),
      name: 'patrolkit',
      uri: 'https://apt.patrolkit.io',
      suite: 'trixie',
      components: 'main',
      arch: 'arm64',
      signedByKeyId: 'A267DE35610137808C467188B7B81B42B960F4F0',
    },
  });

  // Created, never updated. This is a bring-up default so a freshly imaged Pi
  // installs *something* the first time it is provisioned; the moment anyone
  // edits it in Platform Admin, the seed must stop having an opinion. The
  // package is the repository's stub app because it is the only one published
  // — swap it for the real signage package when there is one.
  const signageProfile = await prisma.bootstrapProfile.findUnique({
    where: { role: 'signage.display' },
  });
  if (!signageProfile) {
    await prisma.bootstrapProfile.create({
      data: {
        id: createId(),
        role: 'signage.display',
        deviceType: 'patrolkit-signage',
        updateWindow: '03:00-05:00',
        checkinIntervalSec: 3600,
        repositories: { connect: { id: aptRepo.id } },
        packages: {
          create: [
            // Tracking rather than pinned: nothing has been released to pin to,
            // and during bring-up "whatever was published last" is the answer.
            { id: createId(), name: 'patrolkit-stub-app', version: null, position: 0 },
          ],
        },
      },
    });
    console.log('✓ signage bootstrap profile seeded (patrolkit-stub-app, tracking latest)');
  }
  console.log('✓ device bootstrap seeded');

  // 3. Upsert super admin
  const superAdminEmail = process.env.SEED_SUPERADMIN_EMAIL;
  if (superAdminEmail) {
    await upsertPerson({
      email: superAdminEmail,
      firstName: 'Super',
      lastName: 'Admin',
      phone: '+15550100000',
      isSuperAdmin: true,
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
      const owner = await prisma.user.findFirst({ where: { email: superAdminEmail } });
      if (owner) {
        const membership = await upsertMembership(owner.id, demoOrg.id);

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
          { email: 'swap-reporter@example.com', firstName: 'Swap', lastName: 'Reporter', phone: '+15550101001', perms: ['ski_swap:report'] },
          { email: 'swap-manager@example.com',  firstName: 'Swap', lastName: 'Manager',  phone: '+15550101002', perms: ['ski_swap:report', 'ski_swap:manage'] },
          { email: 'swap-admin@example.com',    firstName: 'Swap', lastName: 'Admin',    phone: '+15550101003', perms: ['ski_swap:report', 'ski_swap:manage', 'ski_swap:admin'] },
        ] as const;

        for (const u of swapUsers) {
          const devUser = await upsertPerson({
            email: u.email, firstName: u.firstName, lastName: u.lastName, phone: u.phone,
          });
          const devMembership = await upsertMembership(devUser.id, demoOrg.id);
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

        // Most roster rows carry a contact, matching a real import; the last has
        // neither, which is the permitted contactless case.
        const patrollers = [
          { firstName: 'Jane',  lastName: 'Doe',      nspId: '100001', patrolLevel: 'Senior',    email: 'jane.doe@example.com',  phone: '+15550301001' },
          { firstName: 'John',  lastName: 'Smith',    nspId: '100002', patrolLevel: 'Basic',     email: 'john.smith@example.com' },
          { firstName: 'Maria', lastName: 'Garcia',   nspId: '100003', patrolLevel: 'Certified', phone: '+15550301003' },
          { firstName: 'Chen',  lastName: 'Wei',      nspId: '100004', patrolLevel: 'Candidate', email: 'chen.wei@example.com',  phone: '+15550301004' },
          { firstName: 'Aisha', lastName: 'Patel',    nspId: '100005', patrolLevel: 'Senior',    email: 'aisha.patel@example.com' },
          { firstName: 'Tom',   lastName: 'Anderson', nspId: '100006', patrolLevel: 'Basic' },
        ] as const;
        for (const pt of patrollers) {
          const person = await upsertPerson({
            nspId: pt.nspId,
            firstName: pt.firstName,
            lastName: pt.lastName,
            patrolLevel: pt.patrolLevel,
            ...('email' in pt ? { email: pt.email } : {}),
            ...('phone' in pt ? { phone: pt.phone } : {}),
          });
          const m = await upsertMembership(person.id, demoOrg.id);
          await prisma.patrollerProfile.upsert({
            where: { membershipId: m.id },
            update: { active: true, deletedAt: null },
            create: { id: createId(), membershipId: m.id },
          });
        }
        console.log(`✓ Time-clock demo resorts, settings, and roster seeded`);

        // Dev users with escalating time-tracking permission levels
        const timeUsers = [
          { email: 'time-reporter@example.com', firstName: 'Time', lastName: 'Reporter', phone: '+15550201001', perms: ['time_tracking:report'] },
          { email: 'time-manager@example.com',  firstName: 'Time', lastName: 'Manager',  phone: '+15550201002', perms: ['time_tracking:report', 'time_tracking:manage'] },
          { email: 'time-admin@example.com',    firstName: 'Time', lastName: 'Admin',    phone: '+15550201003', perms: ['time_tracking:report', 'time_tracking:manage', 'time_tracking:admin'] },
        ] as const;

        for (const u of timeUsers) {
          const devUser = await upsertPerson({
            email: u.email, firstName: u.firstName, lastName: u.lastName, phone: u.phone,
          });
          const devMembership = await upsertMembership(devUser.id, demoOrg.id);
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
