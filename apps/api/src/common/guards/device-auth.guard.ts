import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { JwtService } from '../../auth/jwt.service';

export interface AuthenticatedDevice {
  deviceId: string;
  orgId: string;
  clientId: string;
  /** What the device is allowed to do. A device's job is its role. */
  role: string;
}

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { device?: AuthenticatedDevice }>();
    const authHeader = req.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const token = authHeader.slice(7);
    try {
      const payload = await this.jwtService.verifyDeviceToken(token);
      req.device = {
        deviceId: payload.deviceId,
        orgId: payload.orgId,
        clientId: payload.sub,
        role: payload.role,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired device token');
    }
  }
}
