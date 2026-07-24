import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { MODULE_KEY_METADATA } from '../decorators/require-module.decorator';

@Injectable()
export class ModuleEnabledGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const moduleKey = this.reflector.getAllAndOverride<string>(MODULE_KEY_METADATA, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!moduleKey) return true;

    const req = ctx.switchToHttp().getRequest<{ params: Record<string, string> }>();
    const orgId = req.params['orgId'];
    if (!orgId) throw new ForbiddenException('orgId required for module check');

    const orgModule = await this.prisma.orgModule.findUnique({
      where: { orgId_moduleKey: { orgId, moduleKey } },
      include: { module: true },
    });

    if (!orgModule) throw new ForbiddenException(`Module '${moduleKey}' is not available`);
    // Core modules always pass
    if (orgModule.module.isCore) return true;
    if (!orgModule.enabled) throw new ForbiddenException(`Module '${moduleKey}' is not enabled`);

    return true;
  }
}
