import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../mail/mail.service';
import { PersonService } from '../common/identity/person.service';
import { MembershipTouchService } from '../common/identity/membership-touch.service';
import { displayName } from '../common/util/person';
import type { BusinessSellerMemberResponse } from '../contracts/ski-swap.contracts';

const PROFILE_INCLUDE = {
  membership: { include: { user: true } },
} as const;

type BusinessProfile = {
  id: string;
  businessName: string | null;
  deletedAt: Date | null;
  membership: {
    userId: string;
    joinedAt: Date;
    user: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null };
  };
};

function toResponse(p: BusinessProfile): BusinessSellerMemberResponse {
  return {
    userId: p.membership.userId,
    sellerId: p.id,
    email: p.membership.user.email,
    businessName: p.businessName,
    displayName: displayName(p.membership.user, p.businessName),
    phone: p.membership.user.phone,
    joinedAt: p.membership.joinedAt.toISOString(),
    removedAt: p.deletedAt?.toISOString() ?? null,
  };
}

/**
 * Business sellers are no longer a special kind of account — they are a seller
 * profile that carries a business name. The invite still creates the person,
 * the membership and a 30-day challenge, but it no longer grants a permission
 * or writes a second person row.
 */
@Injectable()
export class BusinessSellerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly mailService: MailService,
    private readonly people: PersonService,
    private readonly touch: MembershipTouchService,
  ) {}

  /**
   * Name-only autocomplete over every business on the platform. A business name
   * is not personal data, so this is deliberately global — it is what stops two
   * orgs inventing two spellings of the same shop.
   */
  async searchBusinesses(query: string): Promise<{ businessName: string; userId: string }[]> {
    if (!query.trim()) return [];
    const profiles = await this.prisma.sellerProfile.findMany({
      where: { deletedAt: null, businessName: { contains: query.trim() } },
      include: { membership: { select: { userId: true } } },
      take: 10,
    });
    const seen = new Set<string>();
    const out: { businessName: string; userId: string }[] = [];
    for (const p of profiles) {
      const key = `${p.businessName}:${p.membership.userId}`;
      if (!p.businessName || seen.has(key)) continue;
      seen.add(key);
      out.push({ businessName: p.businessName, userId: p.membership.userId });
    }
    return out;
  }

  /**
   * Adds a business seller, and writes to them only if asked to.
   *
   * The name is the only thing required. A shop that will never sign in — one
   * whose file staff upload on their behalf — is recorded and left alone;
   * `sendInvite` is how the old always-notify behaviour is asked for.
   */
  async invite(
    orgId: string,
    inviterUserId: string,
    data: { businessName: string; email?: string; sendInvite?: boolean },
  ): Promise<BusinessSellerMemberResponse> {
    void inviterUserId;

    const existingUser = data.email ? await this.people.resolve({ email: data.email }) : null;
    if (existingUser) {
      const existingProfile = await this.prisma.sellerProfile.findFirst({
        where: { membership: { orgId, userId: existingUser.id } },
      });
      if (existingProfile && !existingProfile.deletedAt) {
        throw new ConflictException('That business is already an active seller in this org');
      }
    }

    // The invite knows the mailbox, not the person — name parts stay empty until
    // they sign in and fill them in.
    const { user, created } = await this.people.resolveOrCreate({ email: data.email });
    const membership = await this.people.upsertMembership(user.id, orgId);

    const profile = await this.prisma.sellerProfile.upsert({
      where: { membershipId: membership.id },
      update: { deletedAt: null, businessName: data.businessName },
      create: { id: createId(), membershipId: membership.id, businessName: data.businessName },
    });
    await this.touch.touch(membership.id);

    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { name: true },
    });

    // Only when asked, and only when there is somewhere to write to. Delivery is
    // suppressed globally anyway while OUTBOUND_NOTIFICATIONS is off.
    if (data.sendInvite && data.email) {
      if (created) {
        await this.authService
          .createInviteChallenge(user.id, data.email, org.name)
          .catch(() => {});
      } else {
        this.mailService.sendSellerAddedNotification(data.email, org.name).catch(() => {});
      }
    }

    return toResponse(await this.findProfileOrThrow(profile.id));
  }

  async list(orgId: string): Promise<BusinessSellerMemberResponse[]> {
    const profiles = await this.prisma.sellerProfile.findMany({
      where: { businessName: { not: null }, membership: { orgId } },
      include: PROFILE_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return profiles.map(toResponse);
  }

  /** Soft removal and restore. The profile row always survives. */
  async setRemoved(
    orgId: string,
    targetUserId: string,
    removed: boolean,
  ): Promise<BusinessSellerMemberResponse> {
    const profile = await this.prisma.sellerProfile.findFirst({
      where: { businessName: { not: null }, membership: { orgId, userId: targetUserId } },
      include: PROFILE_INCLUDE,
    });
    if (!profile) throw new NotFoundException('Business seller not found');

    await this.prisma.sellerProfile.update({
      where: { id: profile.id },
      data: { deletedAt: removed ? new Date() : null },
    });
    await this.touch.touchBySellerProfile(profile.id);

    await this.prisma.auditLog.create({
      data: {
        id: createId(),
        actorType: 'user',
        orgId,
        action: removed ? 'business_seller.removed' : 'business_seller.restored',
        targetType: 'seller_profile',
        targetId: profile.id,
      },
    });

    return toResponse(await this.findProfileOrThrow(profile.id));
  }

  async remove(orgId: string, targetUserId: string): Promise<void> {
    const profile = await this.prisma.sellerProfile.findFirst({
      where: { businessName: { not: null }, membership: { orgId, userId: targetUserId } },
    });
    if (!profile) throw new NotFoundException('Business seller not found');

    const itemCount = await this.prisma.swapItem.count({ where: { sellerId: profile.id, deletedAt: null } });
    if (itemCount > 0) {
      throw new BadRequestException(
        'Cannot remove a business seller with items. Unassign their items first.',
      );
    }

    await this.prisma.sellerProfile.update({
      where: { id: profile.id },
      data: { deletedAt: new Date() },
    });
    await this.touch.touchBySellerProfile(profile.id);
  }

  private async findProfileOrThrow(id: string): Promise<BusinessProfile> {
    return this.prisma.sellerProfile.findUniqueOrThrow({ where: { id }, include: PROFILE_INCLUDE });
  }
}
