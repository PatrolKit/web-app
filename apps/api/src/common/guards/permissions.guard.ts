import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { DEVICE_ROLES_KEY } from '../decorators/require-device-role.decorator';
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
    const deviceRoles = this.reflector.getAllAndOverride<string[]>(DEVICE_ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser; device?: AuthenticatedDevice; params: Record<string, string> }>();

    // Devices and people are different principals: a person's authority is
    // per-person, a device's is entirely its role. Checking a device against
    // permission keys it does not carry would let every device through, which
    // is what the previous unconditional bypass amounted to.
    if (req.device) {
      if (!deviceRoles?.length) {
        throw new ForbiddenException('This endpoint is not available to devices');
      }
      if (!deviceRoles.includes(req.device.role)) {
        throw new ForbiddenException(`Requires a device of role: ${deviceRoles.join(' or ')}`);
      }
      return true;
    }

    if (!required?.length) return true;
    const userId = req.user?.userId;
    const orgId = req.params['orgId'];

    if (!userId || !orgId) throw new ForbiddenException('Insufficient context for permission check');

    const granted = await this.permissionsService.getPermissions(userId, orgId);
    const hasAll = required.every((p) => granted.includes(p));
    if (!hasAll) throw new ForbiddenException('Insufficient permissions');

    return true;
  }
}
