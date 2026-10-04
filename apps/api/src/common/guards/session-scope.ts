import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { SessionScope } from '../../auth/jwt.service';
import { CHECKIN_SESSION_ALLOWED_KEY } from '../decorators/checkin-session-allowed.decorator';

/**
 * Refuses a check-in session anywhere it wasn't let in (Plan 33 D6).
 *
 * Checked where the token is verified, not in a global guard: global guards run
 * before a route's own, so one couldn't see whose token it was.
 */
export function assertSessionScopeAllowed(reflector: Reflector, ctx: ExecutionContext, scope: SessionScope): void {
  if (scope !== 'checkin') return;
  const allowed = reflector.getAllAndOverride<boolean | undefined>(CHECKIN_SESSION_ALLOWED_KEY, [
    ctx.getHandler(),
    ctx.getClass(),
  ]);
  if (allowed) return;
  throw new ForbiddenException({
    message: 'This sign-in is for checking in at the swap. Sign in again to use PatrolKit.',
    code: 'CHECKIN_SESSION',
  });
}
