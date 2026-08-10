import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../mail/mail.service';
import { PermissionsService } from '../permissions/permissions.service';
import { createId } from '@paralleldrive/cuid2';
import type { BusinessSellerMemberResponse } from '../contracts/ski-swap.contracts';

@Injectable()
export class BusinessSellerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly mailService: MailService,
    private readonly permissionsService: PermissionsService,
  ) {}

  async invite(
    orgId: string,
    inviterUserId: string,
    data: { name: string; email: string },
  ): Promise<BusinessSellerMemberResponse> {
    void inviterUserId;

    const isNewUser = !(await this.prisma.user.findUnique({ where: { email: data.email } }));

    let user = await this.prisma.user.findUnique({ where: { email: data.email } });

    if (user) {
      // Check for an existing business_seller membership in this org
      const existing = await this.prisma.membership.findUnique({
        where: { userId_orgId: { userId: user.id, orgId } },
        include: { permissions: { include: { permission: true } } },
      });
      if (existing) {
        const hasBs = existing.permissions.some((mp) => mp.permission.key === 'business_seller');
        if (hasBs) {
          if (existing.status === 'active') {
            throw new ConflictException('This business seller is already active in this org');
          } else {
            throw new ConflictException('This business seller is disabled. Use the enable toggle to restore their access.');
          }
        }
      }
    } else {
      user = await this.prisma.user.create({
        data: { id: createId(), email: data.email, name: data.name },
      });
    }

    const membership = await this.prisma.membership.upsert({
      where: { userId_orgId: { userId: user.id, orgId } },
      update: { status: 'active' },
      create: { id: createId(), userId: user.id, orgId, status: 'active' },
    });

    this.permissionsService.invalidate(user.id, orgId);

    // Ensure the permission record exists (idempotent — guards against an un-seeded DB)
    const bsPerm = await this.prisma.permission.upsert({
      where: { key: 'business_seller' },
      update: {},
      create: { id: createId(), key: 'business_seller', description: 'Self-service access to own consignment items in ski swaps.' },
    });
    await this.prisma.membershipPermission.upsert({
      where: { membershipId_permissionId: { membershipId: membership.id, permissionId: bsPerm.id } },
      update: {},
      create: { membershipId: membership.id, permissionId: bsPerm.id },
    });
    const existingAnonymous = await this.prisma.swapSeller.findFirst({
      where: { orgId, email: data.email, userId: null },
      orderBy: { createdAt: 'desc' },
    });

    let seller;
    if (existingAnonymous) {
      seller = await this.prisma.swapSeller.update({
        where: { id: existingAnonymous.id },
        data: { userId: user.id, type: 'business' },
      });
    } else {
      seller = await this.prisma.swapSeller.create({
        data: {
          id: createId(),
          orgId,
          userId: user.id,
          type: 'business',
          name: data.name,
          email: data.email,
          phone: '',
        },
      });
    }

    // Send appropriate email: 30-day invite link for new accounts, sign-in notification for existing ones
    if (isNewUser) {
      const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } });
      const inviteUrl = await this.authService.createInviteMagicLink(user.id);
      this.mailService.sendSellerInvite(user.email, inviteUrl, org.name).catch(() => {});
    } else {
      const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } });
      this.mailService.sendSellerAddedNotification(user.email, org.name).catch(() => {});
    }

    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      status: membership.status,
      joinedAt: membership.joinedAt.toISOString(),
      seller: { id: seller.id, name: seller.name, email: seller.email ?? null, phone: seller.phone },
    };
  }

  async list(orgId: string): Promise<BusinessSellerMemberResponse[]> {
    const bsPerm = await this.prisma.permission.findUnique({ where: { key: 'business_seller' } });
    if (!bsPerm) return [];

    const memberships = await this.prisma.membership.findMany({
      where: {
        orgId,
        permissions: { some: { permissionId: bsPerm.id } },
      },
      include: {
        user: true,
        permissions: { include: { permission: true } },
      },
      orderBy: { joinedAt: 'asc' },
    });

    const sellerMap = new Map(
      (
        await this.prisma.swapSeller.findMany({
          where: { orgId, userId: { in: memberships.map((m) => m.userId) } },
        })
      ).map((s) => [s.userId!, s]),
    );

    return memberships.map((m) => {
      const s = sellerMap.get(m.userId) ?? null;
      return {
        userId: m.userId,
        email: m.user.email,
        name: m.user.name,
        status: m.status,
        joinedAt: m.joinedAt.toISOString(),
        seller: s ? { id: s.id, name: s.name, email: s.email ?? null, phone: s.phone } : null,
      };
    });
  }

  async setStatus(
    orgId: string,
    targetUserId: string,
    status: 'active' | 'disabled',
  ): Promise<BusinessSellerMemberResponse> {
    const bsPerm = await this.prisma.permission.findUnique({ where: { key: 'business_seller' } });

    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId: targetUserId, orgId } },
      include: { user: true, permissions: { include: { permission: true } } },
    });

    if (!membership) throw new NotFoundException('Membership not found');

    const hasBs =
      bsPerm && membership.permissions.some((mp) => mp.permissionId === bsPerm.id);
    if (!hasBs) throw new NotFoundException('Not a business seller');

    await this.prisma.membership.update({
      where: { id: membership.id },
      data: { status },
    });

    this.permissionsService.invalidate(targetUserId, orgId);

    await this.prisma.auditLog.create({
      data: {
        id: createId(),
        actorType: 'user',
        actorId: undefined,
        orgId,
        action: 'business_seller.status_changed',
        targetType: 'membership',
        targetId: membership.id,
        metadata: { status },
      },
    });

    const seller = await this.prisma.swapSeller.findFirst({ where: { orgId, userId: targetUserId } });

    return {
      userId: membership.userId,
      email: membership.user.email,
      name: membership.user.name,
      status,
      joinedAt: membership.joinedAt.toISOString(),
      seller: seller ? { id: seller.id, name: seller.name, email: seller.email ?? null, phone: seller.phone } : null,
    };
  }
}
