import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { generateKeyPairSync } from 'crypto';
import { AuthService } from './auth.service';
import { JwtService } from './jwt.service';
import { SignInPolicy } from '../common/identity/sign-in-policy.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CHECKIN_SESSION_ALLOWED_KEY } from '../common/decorators/checkin-session-allowed.decorator';

/**
 * Who may sign in to PatrolKit (Plan 33). Members, patrollers and shops; an
 * individual seller only for a swap with Authenticated Seller Status on. A
 * check-in at a station always works, and its session reaches check-in only.
 */

// ─── The policy ──────────────────────────────────────────────────────────────

function policy(found: { superAdmin?: boolean; member?: number; shop?: number; openSwap?: number }) {
  const prisma = {
    user: { findUnique: async () => ({ isSuperAdmin: !!found.superAdmin }) },
    membership: { count: async () => found.member ?? 0 },
    sellerProfile: { count: async () => found.shop ?? 0 },
    swapItem: { count: async () => found.openSwap ?? 0 },
  };
  return new SignInPolicy(prisma as never);
}

describe('who may sign in', () => {
  it('lets in a super admin, a member, and a shop', async () => {
    await expect(policy({ superAdmin: true }).mayUseApp('u')).resolves.toBe(true);
    await expect(policy({ member: 1 }).mayUseApp('u')).resolves.toBe(true);
    await expect(policy({ shop: 1 }).mayUseApp('u')).resolves.toBe(true);
  });

  it('lets in an individual seller only for a swap that allows it', async () => {
    await expect(policy({ openSwap: 1 }).mayUseApp('u')).resolves.toBe(true);
    await expect(policy({}).mayUseApp('u')).resolves.toBe(false);
  });
});

// ─── Signing in ──────────────────────────────────────────────────────────────

function auth(allowed: boolean, record?: { scope: string; expiresAt: Date }) {
  const issued: unknown[] = [];
  const refreshRows: { scope: string; expiresAt: Date }[] = [];
  const prisma = {
    user: { findFirst: async () => ({ id: 'user-1' }) },
    skiSwap: { findFirst: async () => ({ orgId: 'org-1' }) },
    checkinStation: { findFirst: async () => ({ id: 'station-1' }) },
    refreshToken: {
      create: async ({ data }: { data: { scope: string; expiresAt: Date } }) => { refreshRows.push(data); return data; },
      findUnique: async () => (record ? { id: 'rt-1', userId: 'user-1', revokedAt: null, ...record } : null),
      update: async () => ({}),
    },
  };
  const challenges = {
    issue: async (args: unknown) => { issued.push(args); return { challengeId: 'real', channel: 'email' }; },
    confirm: async () => ({ userId: 'user-1', purpose: 'login', context: confirmContext }),
  };
  let confirmContext: object | null = null;
  const jwt = { signAccessToken: async (userId: string, scope = 'full') => `${userId}:${scope}` };
  const config = { get: (_k: string, fallback?: unknown) => fallback };
  const sms = { enabled: async () => true };
  const svc = new AuthService(prisma as never, jwt as never, challenges as never, config as never, sms as never,
    { mayUseApp: async () => allowed } as never);
  const res = { cookie: jest.fn(), clearCookie: jest.fn() };
  const req = { cookies: { refresh_token: 'raw' } };
  return {
    svc, issued, refreshRows, res, req,
    atStation: () => { confirmContext = { swapId: 'swap-1', stationId: 'station-1' }; },
  };
}

describe('asking for a sign-in link', () => {
  it('sends one to someone allowed in', async () => {
    const { svc, issued } = auth(true);
    await expect(svc.requestLogin({ email: 'dana@example.com' })).resolves.toMatchObject({ challengeId: 'real' });
    expect(issued).toHaveLength(1);
  });

  it('sends nothing to someone refused, and answers as for an unknown address', async () => {
    const { svc, issued } = auth(false);
    const answer = await svc.requestLogin({ email: 'dana@example.com' });
    expect(issued).toHaveLength(0);
    expect(answer).toEqual({ challengeId: expect.any(String), channel: 'email' });
    expect(answer!.challengeId).not.toBe('real');
  });

  it('always sends one for a check-in at a station', async () => {
    const { svc, issued } = auth(false);
    await svc.requestLogin({ email: 'dana@example.com', context: { swapId: 'swap-1', stationId: 'station-1' } });
    expect(issued).toHaveLength(1);
  });
});

describe('opening a sign-in link', () => {
  it('signs in someone allowed, for 30 days', async () => {
    const { svc, res, refreshRows } = auth(true);
    await expect(svc.confirmChallenge('c', 'code', res as never, {})).resolves.toMatchObject({ accessToken: 'user-1:full' });
    expect(refreshRows[0].scope).toBe('full');
  });

  it('refuses a link opened after sign-in closed', async () => {
    const { svc, res, refreshRows } = auth(false);
    const err = await svc.confirmChallenge('c', 'code', res as never, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'SIGN_IN_CLOSED' });
    expect(refreshRows).toHaveLength(0);
  });

  it('makes a check-in at a station a check-in session, for a day, whoever it is', async () => {
    const { svc, res, refreshRows, atStation } = auth(false);
    atStation();
    await expect(svc.confirmChallenge('c', 'code', res as never, {})).resolves.toMatchObject({ accessToken: 'user-1:checkin' });
    expect(refreshRows[0].scope).toBe('checkin');
    const hours = (refreshRows[0].expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
  });
});

describe('refreshing a session', () => {
  it('ends a full session once sign-in has closed for that person', async () => {
    const { svc, res, req } = auth(false, { scope: 'full', expiresAt: new Date(Date.now() + 86_400_000) });
    await expect(svc.refresh(req as never, res as never, {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(res.clearCookie).toHaveBeenCalled();
  });

  it('keeps a check-in session’s scope and its original expiry', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const { svc, res, req, refreshRows } = auth(false, { scope: 'checkin', expiresAt });
    await expect(svc.refresh(req as never, res as never, {})).resolves.toEqual({ accessToken: 'user-1:checkin' });
    expect(refreshRows[0]).toMatchObject({ scope: 'checkin', expiresAt });
  });
});

// ─── Where a check-in session reaches ────────────────────────────────────────

describe('a check-in session', () => {
  let jwt: JwtService;
  beforeAll(async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    jwt = new JwtService({
      get: (key: string, fallback?: unknown) => ({
        'app.jwtPrivateKey': Buffer.from(privateKey).toString('base64'),
        'app.jwtPublicKey': Buffer.from(publicKey).toString('base64'),
        'app.nodeEnv': 'test',
      } as Record<string, unknown>)[key] ?? fallback,
    } as never);
    await jwt.onModuleInit();
  });

  function route(token: string, allowsCheckin: boolean) {
    const handler = () => undefined;
    if (allowsCheckin) Reflect.defineMetadata(CHECKIN_SESSION_ALLOWED_KEY, true, handler);
    const req: { headers: Record<string, string>; user?: unknown } = { headers: { authorization: `Bearer ${token}` } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handler,
      getClass: () => class {},
    } as unknown as ExecutionContext;
    return { ctx, req };
  }

  it('reaches a route opened to check-in', async () => {
    const { ctx, req } = route(await jwt.signAccessToken('user-1', 'checkin'), true);
    await expect(new JwtAuthGuard(jwt, new Reflector()).canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ userId: 'user-1', scope: 'checkin' });
  });

  it('is refused everywhere else', async () => {
    const { ctx } = route(await jwt.signAccessToken('user-1', 'checkin'), false);
    const err = await new JwtAuthGuard(jwt, new Reflector()).canActivate(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'CHECKIN_SESSION' });
  });

  it('leaves a full session alone, and an old token without a scope reads as one', async () => {
    const { ctx, req } = route(await jwt.signAccessToken('user-1'), false);
    await expect(new JwtAuthGuard(jwt, new Reflector()).canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ userId: 'user-1', scope: 'full' });
  });
});

// ─── From a receipt's sign-in link (Plan 36) ─────────────────────────────────

describe('asking for a sign-in link from a receipt', () => {
  function auth(receipt: object | null) {
    const issued: { target: string }[] = [];
    const prisma = {
      receipt: { findUnique: async () => receipt },
      user: { findFirst: async () => ({ id: 'user-1' }) },
    };
    const challenges = { issue: async (args: { target: string }) => { issued.push(args); return { challengeId: 'real', channel: 'email' }; } };
    const svc = new AuthService(prisma as never, {} as never, challenges as never, {} as never, { enabled: async () => true } as never,
      { mayUseApp: async () => true } as never);
    return { svc, issued };
  }
  const receipt = {
    revokedAt: null,
    swap: { receiptMode: 'ITEMIZED', receiptLink: 'SELLER_LOGIN', sellerLoginEnabled: true },
    seller: { membership: { user: { verifiedEmail: 'dana@example.com' } } },
  };

  it('sends one to the seller’s verified email', async () => {
    const { svc, issued } = auth(receipt);
    await expect(svc.requestLogin({ receiptToken: 'tok' })).resolves.toMatchObject({ challengeId: 'real' });
    expect(issued.map((i) => i.target)).toEqual(['dana@example.com']);
  });

  it('answers with a decoy, sending nothing, for a receipt that doesn’t link to sign-in', async () => {
    const { svc, issued } = auth({ ...receipt, swap: { ...receipt.swap, receiptLink: 'SELLER_STATUS' } });
    const answer = await svc.requestLogin({ receiptToken: 'tok' });
    expect(answer?.challengeId).not.toBe('real');
    expect(issued).toEqual([]);
  });
});
