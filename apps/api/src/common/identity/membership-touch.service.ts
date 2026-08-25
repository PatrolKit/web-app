import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Owns `Membership.updatedAt`, the delta-sync watermark that offline devices
 * poll with `?updatedSince=`.
 *
 * A roster row is assembled from three tables — `User` (name, NSP ID, patrol
 * level), `Membership` (removal) and `PatrollerProfile` (active) — so Prisma's
 * `@updatedAt` cannot maintain it: a rename on `User` has to bump every
 * membership that person holds, or a device never learns about the change.
 * `Membership.updatedAt` is therefore a plain column, and this service is the
 * only thing that writes it.
 */
@Injectable()
export class MembershipTouchService {
  constructor(private readonly prisma: PrismaService) {}

  /** Bumps one membership. Call after any write to it or to its profiles. */
  async touch(membershipId: string): Promise<void> {
    await this.prisma.membership.update({
      where: { id: membershipId },
      data: { updatedAt: new Date() },
    });
  }

  /**
   * Bumps every membership a person holds. Call after any write to a
   * roster-visible field on `User` — name, NSP ID, patrol level.
   */
  async touchAllForUser(userId: string): Promise<void> {
    await this.prisma.membership.updateMany({
      where: { userId },
      data: { updatedAt: new Date() },
    });
  }

  /** Bumps the membership owning a seller profile, if it still exists. */
  async touchBySellerProfile(sellerProfileId: string): Promise<void> {
    const profile = await this.prisma.sellerProfile.findUnique({
      where: { id: sellerProfileId },
      select: { membershipId: true },
    });
    if (profile) await this.touch(profile.membershipId);
  }

  /** Bumps the membership owning a patroller profile, if it still exists. */
  async touchByPatrollerProfile(patrollerProfileId: string): Promise<void> {
    const profile = await this.prisma.patrollerProfile.findUnique({
      where: { id: patrollerProfileId },
      select: { membershipId: true },
    });
    if (profile) await this.touch(profile.membershipId);
  }
}
