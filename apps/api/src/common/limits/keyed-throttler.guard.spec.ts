import { generateKeyPairSync } from 'crypto';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService, type ThrottlerModuleOptions } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import { JwtService } from '../../auth/jwt.service';
import { KeyedThrottlerGuard } from './keyed-throttler.guard';
import { Limit } from './limit.decorator';
import { LimitUsageService, type LimitHit } from './limit-usage.service';
import { LIMITS } from './limits';

/**
 * Who a request is counted against (Plan 26 §8).
 *
 * The keys are hashed before they reach the store, so the probe below records
 * what the guard asked to be hashed — the tracker — rather than guessing from
 * the outside which bucket moved.
 */

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { priv: Buffer.from(privateKey).toString('base64'), pub: Buffer.from(publicKey).toString('base64') };
}

async function jwtWith(keys: { priv: string; pub: string }, accessTtl = 900): Promise<JwtService> {
  const svc = new JwtService({
    get: (key: string, fallback?: unknown) =>
      ({
        'app.jwtPrivateKey': keys.priv,
        'app.jwtPublicKey': keys.pub,
        'app.nodeEnv': 'test',
        'app.accessTokenTtl': accessTtl,
        'app.deviceTokenTtl': 3600,
      })[key] ?? fallback,
  } as never);
  await svc.onModuleInit();
  return svc;
}

class Routes {
  anything() { return 'ok'; }
  @Limit('auth.login') login() { return 'ok'; }
}

const storages: ThrottlerStorageService[] = [];
afterAll(() => storages.forEach((s) => s.onApplicationShutdown()));

async function harness(realUsage?: LimitUsageService) {
  const keys = keyPair();
  const jwt = await jwtWith(keys);
  const trackers: string[] = [];
  const hits: LimitHit[] = [];
  const usage = realUsage ?? ({ record: (hit: LimitHit) => hits.push(hit) } as unknown as LimitUsageService);

  class Probe extends KeyedThrottlerGuard {
    protected override generateKey(context: ExecutionContext, suffix: string, name: string): string {
      trackers.push(suffix);
      return super.generateKey(context, suffix, name);
    }
  }
  const options: ThrottlerModuleOptions = [{ name: 'default', ttl: 60_000, limit: 300 }];
  const storage = new ThrottlerStorageService();
  storages.push(storage);
  const guard = new Probe(options, storage, new Reflector(), jwt, usage);
  await guard.onModuleInit();

  const headers: Record<string, unknown> = {};
  const request = (handler: 'anything' | 'login', opts: { token?: string; ip?: string } = {}) => {
    const req = {
      ip: opts.ip ?? '203.0.113.7',
      method: 'POST',
      path: `/${handler}`,
      params: {},
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    };
    const res = { header: (k: string, v: unknown) => { headers[k] = v; } };
    const context = {
      getHandler: () => Routes.prototype[handler],
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    return guard.canActivate(context);
  };

  return { keys, jwt, trackers, hits, headers, request };
}

describe('KeyedThrottlerGuard — who is counted', () => {
  it('counts a signed-in user against their account', async () => {
    const h = await harness();
    await h.request('anything', { token: await h.jwt.signAccessToken('user-1') });
    expect(h.trackers).toEqual(['user:user-1']);
    expect(h.hits[0]).toMatchObject({ limitId: 'requests.signedIn', keyKind: 'user' });
  });

  it('counts a device against the device, not its org or its address', async () => {
    const h = await harness();
    const token = await h.jwt.signDeviceToken({ sub: 'device-1', deviceId: 'device-1', orgId: 'org-1', role: 'x' });
    await h.request('anything', { token });
    expect(h.trackers).toEqual(['device:device-1']);
    expect(h.hits[0]).toMatchObject({ limitId: 'requests.signedIn', keyKind: 'device' });
  });

  it('counts an expired token by address, like no token at all', async () => {
    const h = await harness();
    const stale = await jwtWith(h.keys, 0);
    const token = await stale.signAccessToken('user-1');
    await new Promise((r) => setTimeout(r, 1100));
    await h.request('anything', { token });
    expect(h.trackers).toEqual(['ip:203.0.113.7']);
    expect(h.hits[0]).toMatchObject({ limitId: 'requests.anonymous', keyKind: 'ip' });
  });

  it('counts a forged token by address, so forging one buys no fresh bucket', async () => {
    const h = await harness();
    const forger = await jwtWith(keyPair());
    await h.request('anything', { token: await forger.signAccessToken('user-1') });
    await h.request('anything', { token: 'not-a-token' });
    expect(h.trackers).toEqual(['ip:203.0.113.7', 'ip:203.0.113.7']);
  });

  it('counts a front-door route by address even with a valid token', async () => {
    const h = await harness();
    await h.request('login', { token: await h.jwt.signAccessToken('user-1') });
    expect(h.trackers).toEqual(['ip:203.0.113.7']);
    expect(h.hits[0]).toMatchObject({ limitId: 'auth.login', keyKind: 'ip' });
  });

  it('gives two signed-in people behind one address a bucket each', async () => {
    const h = await harness();
    const a = await h.jwt.signAccessToken('user-a');
    const b = await h.jwt.signAccessToken('user-b');
    for (let i = 0; i < 3; i++) {
      await h.request('anything', { token: a });
      await h.request('anything', { token: b });
    }
    expect(h.hits.filter((x) => x.hits === 3)).toHaveLength(2);
  });
});

describe('KeyedThrottlerGuard — the limit itself', () => {
  it('takes its number from the registry and refuses past it, with Retry-After', async () => {
    const h = await harness();
    const { limit } = LIMITS['auth.login'];
    for (let i = 0; i < limit; i++) await h.request('login');
    await expect(h.request('login')).rejects.toBeInstanceOf(ThrottlerException);
    expect(h.headers['Retry-After']).toBeGreaterThan(0);
    expect(h.hits.at(-1)).toMatchObject({ limitId: 'auth.login', refused: true });
  });

  it('keeps another address unaffected', async () => {
    const h = await harness();
    for (let i = 0; i <= LIMITS['auth.login'].limit; i++) await h.request('login').catch(() => undefined);
    await expect(h.request('login', { ip: '198.51.100.9' })).resolves.toBe(true);
  });
});

describe('KeyedThrottlerGuard — what reaches the health record', () => {
  it('writes how far a key got, never the key', async () => {
    const written: { values: unknown[] }[] = [];
    const prisma = {
      $executeRaw: async (sql: { values: unknown[] }) => { written.push(sql); return 1; },
      limitUsage: { deleteMany: async () => ({ count: 0 }) },
    };
    const resolver = { resolve: async () => ({ orgId: '', swapId: '' }) };
    const usage = new LimitUsageService(prisma as never, resolver as never);
    const h = await harness(usage);

    const token = await h.jwt.signAccessToken('user-4471');
    for (let i = 0; i < 3; i++) await h.request('anything', { token });
    for (let i = 0; i < 3; i++) await h.request('login');
    await new Promise((r) => setImmediate(r));
    await usage.flush();

    const values = written.flatMap((sql) => sql.values).map(String);
    expect(values).toEqual(expect.arrayContaining(['requests.signedIn', 'auth.login']));
    expect(values.filter((v) => v.includes('user-4471') || v.includes('203.0.113.7'))).toEqual([]);
  });
});
