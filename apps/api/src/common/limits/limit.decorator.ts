import { SetMetadata } from '@nestjs/common';
import type { RouteLimitId } from './limits';

export const ROUTE_LIMIT_KEY = 'routeLimit';

/**
 * Puts a route or controller under one of the per-IP limits in `LIMITS`.
 *
 * The number is not written here — the guard reads it from the registry — so
 * there is no second copy to drift. A route with no `@Limit` gets the default:
 * per account or device when a token verifies, per IP when none does.
 */
export const Limit = (id: RouteLimitId) => SetMetadata(ROUTE_LIMIT_KEY, id);
