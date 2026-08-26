import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { JwtService } from '../../auth/jwt.service';
import type { AuthenticatedDevice } from './device-auth.guard';
import type { AuthenticatedUser } from './jwt-auth.guard';

@Injectable()
export class OrDeviceAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser; device?: AuthenticatedDevice; params: Record<string, string> }>();

    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const token = authHeader.slice(7);

    try {
      const payload = await this.jwtService.verifyAccessToken(token);
      req.user = { userId: payload.sub };
      return true;
    } catch {
      // not a user token — try device token
    }

    try {
      const payload = await this.jwtService.verifyDeviceToken(token);
      const orgId = req.params['orgId'];
      if (payload.orgId !== orgId) {
        throw new UnauthorizedException('Device does not belong to this organization');
      }
      req.device = {
        deviceId: payload.deviceId,
        orgId: payload.orgId,
        clientId: payload.sub,
        role: payload.role,
      };
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
