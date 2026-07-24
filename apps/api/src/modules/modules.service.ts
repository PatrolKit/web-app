import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createId } from '@paralleldrive/cuid2';
export interface ModuleResponse {
  key: string;
  name: string;
  description: string;
  isCore: boolean;
  enabled: boolean;
  enabledAt: Date | null;
}

@Injectable()
export class ModulesService {
  constructor(private readonly prisma: PrismaService) {}

  async listModules(orgId: string): Promise<ModuleResponse[]> {
    const catalog = await this.prisma.moduleCatalog.findMany({ orderBy: { key: 'asc' } });
    const orgModules = await this.prisma.orgModule.findMany({ where: { orgId } });
    const byKey = new Map(orgModules.map((om) => [om.moduleKey, om]));

    return catalog.map((m) => {
      const om = byKey.get(m.key);
      return {
        key: m.key,
        name: m.name,
        description: m.description,
        isCore: m.isCore,
        enabled: om?.enabled ?? false,
        enabledAt: om?.enabledAt ?? null,
      };
    });
  }

  async setModuleEnabled(
    orgId: string,
    moduleKey: string,
    enabled: boolean,
    actorUserId: string,
  ): Promise<ModuleResponse> {
    const mod = await this.prisma.moduleCatalog.findUnique({ where: { key: moduleKey } });
    if (!mod) throw new NotFoundException(`Module '${moduleKey}' not found`);
    if (mod.isCore && !enabled) throw new BadRequestException('Core modules cannot be disabled');

    await this.prisma.orgModule.upsert({
      where: { orgId_moduleKey: { orgId, moduleKey } },
      update: {
        enabled,
        enabledAt: enabled ? new Date() : null,
        enabledBy: enabled ? actorUserId : null,
      },
      create: {
        id: createId(),
        orgId,
        moduleKey,
        enabled,
        enabledAt: enabled ? new Date() : null,
        enabledBy: enabled ? actorUserId : null,
      },
    });

    const om = await this.prisma.orgModule.findUniqueOrThrow({
      where: { orgId_moduleKey: { orgId, moduleKey } },
    });

    return {
      key: mod.key,
      name: mod.name,
      description: mod.description,
      isCore: mod.isCore,
      enabled: om.enabled,
      enabledAt: om.enabledAt,
    };
  }
}
