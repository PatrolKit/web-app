import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { OrgResponse, PatchOrgRequest } from '../contracts/org.contracts';

@Injectable()
export class OrgsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrg(orgId: string): Promise<OrgResponse> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      include: { orgModules: { include: { module: true } } },
    });
    if (!org) throw new NotFoundException('Organization not found');

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      status: org.status,
      logoUrl: org.logoUrl ?? null,
      modules: org.orgModules.map((om) => ({
        key: om.moduleKey,
        name: om.module.name,
        enabled: om.enabled,
        isCore: om.module.isCore,
      })),
    };
  }

  async patchOrg(orgId: string, data: PatchOrgRequest): Promise<OrgResponse> {
    await this.prisma.organization.update({
      where: { id: orgId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.status !== undefined && { status: data.status }),
      },
    });
    return this.getOrg(orgId);
  }
}
