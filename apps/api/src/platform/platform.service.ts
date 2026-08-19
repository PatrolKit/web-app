import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createId } from '@paralleldrive/cuid2';
import type { CreateOrgRequest, PlatformOrgResponse, PlatformPatchOrgRequest } from '../contracts/members.contracts';
import { ALL_PERMISSION_KEYS } from '../contracts/org.contracts';

@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService) {}

  async listOrgs(): Promise<PlatformOrgResponse[]> {
    const orgs = await this.prisma.organization.findMany({ orderBy: { createdAt: 'desc' } });
    return orgs.map((o) => ({
      id: o.id, name: o.name, slug: o.slug, status: o.status, createdAt: o.createdAt,
    }));
  }

  async createOrg(data: CreateOrgRequest): Promise<PlatformOrgResponse> {
    const existing = await this.prisma.organization.findUnique({ where: { slug: data.slug } });
    if (existing) throw new ConflictException('Slug already in use');

    const owner = await this.prisma.user.findUnique({ where: { email: data.ownerEmail } });
    if (!owner) throw new NotFoundException(`User not found: ${data.ownerEmail}`);

    const org = await this.prisma.organization.create({
      data: { id: createId(), name: data.name, slug: data.slug },
    });

    // Seed owner membership with all permissions
    const membership = await this.prisma.membership.create({
      data: { id: createId(), userId: owner.id, orgId: org.id },
    });
    // business_seller is an external-seller role, not an admin permission
    const adminPermKeys = ALL_PERMISSION_KEYS.filter((k) => k !== 'business_seller');
    const allPerms = await this.prisma.permission.findMany({ where: { key: { in: adminPermKeys } } });
    await this.prisma.membershipPermission.createMany({
      data: allPerms.map((p) => ({ membershipId: membership.id, permissionId: p.id })),
    });

    // Seed user_management core module (enabled)
    await this.prisma.orgModule.create({
      data: {
        id: createId(), orgId: org.id, moduleKey: 'user_management',
        enabled: true, enabledAt: new Date(), enabledBy: owner.id,
      },
    });

    return { id: org.id, name: org.name, slug: org.slug, status: org.status, createdAt: org.createdAt };
  }

  async getOrg(id: string): Promise<PlatformOrgResponse> {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException('Organization not found');
    return { id: org.id, name: org.name, slug: org.slug, status: org.status, createdAt: org.createdAt };
  }

  async patchOrg(id: string, data: PlatformPatchOrgRequest): Promise<PlatformOrgResponse> {
    const org = await this.prisma.organization.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.status !== undefined && { status: data.status }),
      },
    });
    return { id: org.id, name: org.name, slug: org.slug, status: org.status, createdAt: org.createdAt };
  }

  async deleteOrg(id: string): Promise<void> {
    await this.prisma.organization.delete({ where: { id } });
  }
}
