import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Whether an org has a module turned on.
 *
 * One implementation, because there are two callers with the same question and
 * a nuance worth not duplicating: a core module is on whether or not the
 * `enabled` flag says so, and a module with no row at all is not merely off but
 * unavailable to that org.
 */
@Injectable()
export class ModuleAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(orgId: string, moduleKey: string): Promise<boolean> {
    const orgModule = await this.prisma.orgModule.findUnique({
      where: { orgId_moduleKey: { orgId, moduleKey } },
      include: { module: true },
    });
    if (!orgModule) return false;
    return orgModule.module.isCore || orgModule.enabled;
  }
}
