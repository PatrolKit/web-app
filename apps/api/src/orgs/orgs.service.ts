import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../ski-swap/s3.service';
import type { OrgResponse, PatchOrgRequest } from '../contracts/org.contracts';

@Injectable()
export class OrgsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

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
    try {
      await this.prisma.organization.update({
        where: { id: orgId },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.slug !== undefined && { slug: data.slug }),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That slug is already in use by another organization');
      }
      throw err;
    }
    return this.getOrg(orgId);
  }

  async uploadLogo(orgId: string, file: { buffer: Buffer; mimetype: string }): Promise<OrgResponse> {
    let url: string;
    if (this.s3.configured) {
      url = await this.s3.upload(`logos/${orgId}`, file.buffer, file.mimetype);
    } else {
      url = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    }
    await this.prisma.organization.update({ where: { id: orgId }, data: { logoUrl: url } });
    return this.getOrg(orgId);
  }

  async deleteLogo(orgId: string): Promise<OrgResponse> {
    await this.s3.delete(`logos/${orgId}`).catch(() => {});
    await this.prisma.organization.update({ where: { id: orgId }, data: { logoUrl: null } });
    return this.getOrg(orgId);
  }
}
