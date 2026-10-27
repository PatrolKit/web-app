import type { PrismaService } from '../prisma/prisma.service';

/**
 * The seller a write naming `sellerId` is for (Plan 57 D5): the kept seller
 * when this one was merged, otherwise itself. One hop, because a merge points
 * everything at the kept seller. Never throws: callers check the seller as
 * they always have.
 *
 * What lets an iPad's offline queue, and a receipt link sent before a merge,
 * land on the seller everything moved to.
 */
export async function followMerge(prisma: Pick<PrismaService, 'sellerProfile'>, orgId: string, sellerId: string): Promise<string> {
  const row = await prisma.sellerProfile.findFirst({
    where: { id: sellerId, membership: { orgId } },
    select: { mergedIntoId: true },
  });
  return row?.mergedIntoId ?? sellerId;
}
