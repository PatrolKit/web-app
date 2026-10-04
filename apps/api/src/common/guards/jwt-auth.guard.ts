import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { JwtService, type SessionScope } from '../../auth/jwt.service';
import { assertSessionScopeAllowed } from './session-scope';

export interface AuthenticatedUser {
  userId: string;
  /** `checkin` for a session started at a station (Plan 33). */
  scope?: SessionScope;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const authHeader = req.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const token = authHeader.slice(7);
    let payload;
    try {
      payload = await this.jwtService.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    // Outside the try: a refused check-in session is a 403, not a bad token.
    assertSessionScopeAllowed(this.reflector, ctx, payload.scope);
    req.user = { userId: payload.sub, scope: payload.scope };
    return true;
  }
}
