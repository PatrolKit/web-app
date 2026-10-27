import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { IS_MEMBER } from '../common/identity/membership-kinds';
import { assertPinAvailable } from '../common/identity/clock-code';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipTouchService } from '../common/identity/membership-touch.service';
import { createId } from '@paralleldrive/cuid2';
import { displayName, normalizeNamePart } from '../common/util/person';
import type { MeResponse, MyClockResponse, PermissionKey } from '../contracts/org.contracts';

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly touch: MembershipTouchService,
  ) {}

  async getMe(userId: string, sessionScope: MeResponse['sessionScope'] = 'full'): Promise<MeResponse> {
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
      sessionScope,
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

  /** Each org where they're a member, and how they clock in there (Plan 57 D7). */
  async myClock(userId: string): Promise<MyClockResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { nspId: true } });
    if (!user) throw new NotFoundException('User not found');
    const memberships = await this.prisma.membership.findMany({
      where: { userId, deletedAt: null, ...IS_MEMBER },
      include: {
        org: { include: { orgModules: { where: { moduleKey: 'time_tracking', enabled: true } } } },
        patrollerProfile: true,
      },
      orderBy: { joinedAt: 'asc' },
    });
    return {
      orgs: memberships.map((m) => ({
        orgId: m.orgId,
        orgName: m.org.name,
        timeTracking: m.org.orgModules.length > 0,
        nspId: user.nspId,
        clockPinSet: !user.nspId && !!m.patrollerProfile?.clockPin,
        inactive: m.patrollerProfile ? !m.patrollerProfile.active : false,
      })),
    };
  }

  /**
   * Sets the PIN a member with no NSP ID clocks in with at one org (D7, D8).
   * Their NSP ID, when they have one, is how they clock in instead.
   */
  async setClockPin(userId: string, orgId: string, pin: string): Promise<MyClockResponse> {
    const membership = await this.prisma.membership.findFirst({
      where: { userId, orgId, deletedAt: null, ...IS_MEMBER },
      include: { user: { select: { nspId: true } }, patrollerProfile: true },
    });
    if (!membership) throw new NotFoundException('You are not a member there');
    if (membership.user.nspId) {
      throw new BadRequestException('You clock in with your NSP ID there, so you need no PIN.');
    }
    await assertPinAvailable(this.prisma, orgId, pin, membership.id);
    await this.prisma.patrollerProfile.upsert({
      where: { membershipId: membership.id },
      update: { clockPin: pin },
      create: { id: createId(), membershipId: membership.id, clockPin: pin },
    });
    // The iPads learn it on their next roster delta.
    await this.touch.touch(membership.id);
    await this.prisma.auditLog.create({
      data: { actorType: 'user', actorId: userId, orgId, action: 'member.clock_pin.set', targetType: 'user', targetId: userId },
    });
    return this.myClock(userId);
  }
}
