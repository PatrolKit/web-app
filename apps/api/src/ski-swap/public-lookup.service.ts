import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../common/util/person';
import type { SellerFindResponse } from '../contracts/ski-swap.contracts';

@Injectable()
export class PublicLookupService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrgBranding(orgSlug: string): Promise<{ orgName: string; logoUrl: string | null }> {
    const org = await this.prisma.organization.findFirst({ where: { slug: orgSlug.toLowerCase() } });
    if (!org) throw new NotFoundException('Organization not found');
    return { orgName: org.name, logoUrl: org.logoUrl ?? null };
  }

  async findByEmailAndLast4(orgSlug: string, email: string, last4: string): Promise<SellerFindResponse> {
    const org = await this.prisma.organization.findFirst({ where: { slug: orgSlug.toLowerCase() } });
    if (!org) throw new NotFoundException('No seller found.');

    const orgModule = await this.prisma.orgModule.findUnique({
      where: { orgId_moduleKey: { orgId: org.id, moduleKey: 'ski_swap' } },
    });
    if (!orgModule?.enabled) throw new NotFoundException('No seller found.');

    const profiles = await this.prisma.sellerProfile.findMany({
      where: {
        deletedAt: null,
        membership: { orgId: org.id, deletedAt: null, user: { email: email.toLowerCase() } },
      },
      include: { membership: { select: { user: { select: { phone: true } } } } },
    });

    const match = profiles.find(
      (p) => (normalizePhone(p.membership.user.phone) ?? '').slice(-4) === last4,
    );
    if (!match) throw new NotFoundException('No seller found.');

    return { sellerId: match.id };
  }
}
