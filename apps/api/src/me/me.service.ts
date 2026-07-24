import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { MeResponse, PermissionKey } from '../contracts/org.contracts';

@Injectable()
export class MeService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: 'active' },
      include: { org: true, permissions: { include: { permission: true } } },
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isSuperAdmin: user.isSuperAdmin,
      memberships: memberships.map((m) => ({
        orgId: m.orgId,
        orgName: m.org.name,
        orgSlug: m.org.slug,
        status: m.status,
        permissions: m.permissions.map((mp) => mp.permission.key as PermissionKey),
      })),
    };
  }

  async patchMe(userId: string, name: string): Promise<MeResponse> {
    await this.prisma.user.update({ where: { id: userId }, data: { name } });
    return this.getMe(userId);
  }
}
