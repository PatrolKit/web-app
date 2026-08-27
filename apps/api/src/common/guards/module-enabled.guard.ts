import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModuleAccessService } from '../services/module-access.service';
import { MODULE_KEY_METADATA } from '../decorators/require-module.decorator';

@Injectable()
export class ModuleEnabledGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly moduleAccess: ModuleAccessService,
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

    if (!(await this.moduleAccess.isEnabled(orgId, moduleKey))) {
      throw new ForbiddenException(`Module '${moduleKey}' is not enabled`);
    }

    return true;
  }
}
