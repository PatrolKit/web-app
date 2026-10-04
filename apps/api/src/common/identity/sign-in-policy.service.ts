import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { IS_MEMBER } from './membership-kinds';

/**
 * Who may sign in to PatrolKit (Plan 33 D5).
 *
 * - A super admin.
 * - A real member of an active org: a patroller, someone with permissions, or
 *   someone invited plainly.
 * - A shop, always: shops manage their own inventory.
 * - An individual seller with items in an active swap whose Authenticated
 *   Seller Status is on.
 *
 * Signing in at a station to check in isn't decided here: that always works,
 * and its session reaches the check-in flow only.
 */
@Injectable()
export class SignInPolicy {
  constructor(private readonly prisma: PrismaService) {}

  async mayUseApp(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true } });
    if (!user) return false;
    if (user.isSuperAdmin) return true;

    const liveMembership = { userId, deletedAt: null, org: { status: 'active' } };

    const member = await this.prisma.membership.count({ where: { ...liveMembership, ...IS_MEMBER } });
    if (member > 0) return true;

    const shop = await this.prisma.sellerProfile.count({
      where: { deletedAt: null, businessName: { not: null }, membership: liveMembership },
    });
    if (shop > 0) return true;

    const openSwap = await this.prisma.swapItem.count({
      where: {
        deletedAt: null,
        seller: { deletedAt: null, membership: liveMembership },
        swap: { active: true, sellerLoginEnabled: true },
      },
    });
    return openSwap > 0;
  }
}
