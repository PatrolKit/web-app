// Local dev only — removes all business seller records across all orgs.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('reset-business-sellers is not allowed in production');
  }

  const bsPerm = await prisma.permission.findUnique({ where: { key: 'business_seller' } });
  if (!bsPerm) {
    console.log('No business_seller permission found — nothing to do.');
    return;
  }

  // Find all memberships that hold business_seller
  const bsMembershipIds = (
    await prisma.membershipPermission.findMany({
      where: { permissionId: bsPerm.id },
      select: { membershipId: true },
    })
  ).map((mp) => mp.membershipId);

  // Remove just the business_seller permission row from each membership
  const { count: permCount } = await prisma.membershipPermission.deleteMany({
    where: { permissionId: bsPerm.id },
  });

  // Delete memberships that are now left with zero remaining permissions
  const emptyMembershipIds = (
    await prisma.membership.findMany({
      where: {
        id: { in: bsMembershipIds },
        permissions: { none: {} },
      },
      select: { id: true },
    })
  ).map((m) => m.id);

  const { count: membershipCount } = emptyMembershipIds.length
    ? await prisma.membership.deleteMany({ where: { id: { in: emptyMembershipIds } } })
    : { count: 0 };

  // Delete linked SwapSeller records (type=business, userId set)
  const { count: sellerCount } = await prisma.swapSeller.deleteMany({
    where: { type: 'business', userId: { not: null } },
  });

  console.log(`✓ Removed business_seller permission from ${permCount} membership(s)`);
  console.log(`✓ Deleted ${membershipCount} now-empty membership(s)`);
  console.log(`✓ Deleted ${sellerCount} SwapSeller record(s)`);
  console.log('Business sellers reset. User accounts and multi-permission memberships are preserved.');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
