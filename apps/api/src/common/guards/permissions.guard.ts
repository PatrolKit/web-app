import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedUser } from './jwt-auth.guard';
import type { AuthenticatedDevice } from './device-auth.guard';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;

    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser; device?: AuthenticatedDevice; params: Record<string, string> }>();

    if (req.device) return true;
    const userId = req.user?.userId;
    const orgId = req.params['orgId'];

    if (!userId || !orgId) throw new ForbiddenException('Insufficient context for permission check');

    const granted = await this.permissionsService.getPermissions(userId, orgId);
    const hasAll = required.every((p) => granted.includes(p));
    if (!hasAll) throw new ForbiddenException('Insufficient permissions');

    return true;
  }
}
