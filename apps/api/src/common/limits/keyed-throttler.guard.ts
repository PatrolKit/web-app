import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions, InjectThrottlerStorage, ThrottlerException, ThrottlerGuard,
  type ThrottlerModuleOptions, type ThrottlerRequest, type ThrottlerStorage,
} from '@nestjs/throttler';
import { JwtService } from '../../auth/jwt.service';
import { LimitUsageService, type KeyKind } from './limit-usage.service';
import { ROUTE_LIMIT_KEY } from './limit.decorator';
import { LIMITS, type LimitId, type RouteLimitId } from './limits';
import { currentAttribution } from './request-attribution';

interface Caller {
  kind: 'user' | 'device';
  id: string;
  /** A device token names its org; a user token does not. */
  orgId?: string;
}

/**
 * The throttle, counted against whoever is asking (Plan 26 §8).
 *
 * The stock guard counts by `req.ip`, and at a swap every phone and iPad in the
 * building shares the venue's one address. So a request whose bearer token
 * verifies is counted against its account or device, and everything else —
 * no token, an expired one, a forged one — against its address. Forging a
 * token buys nothing: one that does not verify is counted by IP like no token.
 *
 * Routes under `@Limit` are the front door, where nobody is signed in yet, and
 * are counted by IP whatever comes with them.
 *
 * Runs before the auth guards, so it verifies the token itself. Both kinds are
 * signatures checked without a database read.
 *
 * Every count is also reported to `LimitUsageService`, which is where the
 * half-limit warning and the Server health page come from.
 */
@Injectable()
export class KeyedThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly usage: LimitUsageService,
  ) {
    super(options, storage, reflector);
  }

  protected override async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const { context, throttler, generateKey } = props;
    const { req, res } = this.getRequestResponse(context);

    const routeLimit = this.reflector.getAllAndOverride<RouteLimitId | undefined>(
      ROUTE_LIMIT_KEY, [context.getHandler(), context.getClass()],
    );
    const caller = routeLimit ? null : await this.callerOf(req);
    const limitId: LimitId = routeLimit ?? (caller ? 'requests.signedIn' : 'requests.anonymous');
    const { limit, windowMs } = LIMITS[limitId];

    const keyKind: KeyKind = caller?.kind ?? 'ip';
    const tracker = caller ? `${caller.kind}:${caller.id}` : `ip:${req.ip}`;
    const key = generateKey(context, tracker, throttler.name!);
    const { totalHits, timeToExpire, isBlocked, timeToBlockExpire } =
      await this.storageService.increment(key, windowMs, limit, windowMs, throttler.name!);

    // Routing has settled the params by now; this is the first point that can
    // say which org and swap the request was about.
    const attribution = currentAttribution();
    if (attribution) {
      const params = (req.params ?? {}) as Record<string, string | undefined>;
      attribution.orgId = caller?.orgId ?? params['orgId'];
      attribution.swapId = params['swapId'];
    }
    this.usage.record({
      limitId,
      hits: totalHits,
      refused: isBlocked,
      keyKind,
      where: `${req.method} ${req.route?.path ?? req.path}`,
      attribution: { orgSlug: (req.params as Record<string, string | undefined>)?.['orgSlug'] },
    });

    if (isBlocked) {
      res.header('Retry-After', timeToBlockExpire);
      throw new ThrottlerException();
    }
    res.header(`${this.headerPrefix}-Limit`, limit);
    res.header(`${this.headerPrefix}-Remaining`, Math.max(0, limit - totalHits));
    res.header(`${this.headerPrefix}-Reset`, timeToExpire);
    return true;
  }

  /** The verified owner of the request's bearer token, or nothing. */
  private async callerOf(req: { headers?: Record<string, unknown> }): Promise<Caller | null> {
    const header = req.headers?.['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    if (!token) return null;

    try {
      const { sub } = await this.jwt.verifyAccessToken(token);
      return { kind: 'user', id: sub };
    } catch {
      // Not a user token. It may be a device's.
    }
    try {
      const device = await this.jwt.verifyDeviceToken(token);
      if (device.deviceId) return { kind: 'device', id: device.deviceId, orgId: device.orgId };
    } catch {
      // Expired or forged: counted by address, like no token at all.
    }
    return null;
  }
}
