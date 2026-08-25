import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipTouchService } from '../common/identity/membership-touch.service';
import { displayName, normalizeNamePart } from '../common/util/person';
import type { MeResponse, PermissionKey } from '../contracts/org.contracts';

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly touch: MembershipTouchService,
  ) {}

  async getMe(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const memberships = await this.prisma.membership.findMany({
      where: { userId, deletedAt: null },
      include: {
        org: true,
        permissions: { include: { permission: true } },
        sellerProfile: true,
        patrollerProfile: true,
      },
    });

    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      phone: user.phone,
      phoneVerified: user.phoneVerifiedAt !== null,
      firstName: user.firstName,
      lastName: user.lastName,
      displayName: displayName(user),
      isSuperAdmin: user.isSuperAdmin,
      memberships: memberships.map((m) => ({
        orgId: m.orgId,
        orgName: m.org.name,
        orgSlug: m.org.slug,
        permissions: m.permissions.map((mp) => mp.permission.key as PermissionKey),
        roles: [
          ...(m.sellerProfile && !m.sellerProfile.deletedAt ? (['seller'] as const) : []),
          ...(m.patrollerProfile && !m.patrollerProfile.deletedAt ? (['patroller'] as const) : []),
        ],
      })),
    };
  }

  async patchMe(
    userId: string,
    data: { firstName?: string; lastName?: string },
  ): Promise<MeResponse> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.firstName !== undefined ? { firstName: normalizeNamePart(data.firstName) } : {}),
        ...(data.lastName !== undefined ? { lastName: normalizeNamePart(data.lastName) } : {}),
      },
    });
    // The roster renders this person's name, so every membership's watermark moves.
    await this.touch.touchAllForUser(userId);
    return this.getMe(userId);
  }
}
