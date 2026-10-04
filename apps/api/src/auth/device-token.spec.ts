import type { HttpException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

// The real argon2, with `verify` wrapped so a test can see or replace it.
jest.mock('argon2', () => {
  const actual = jest.requireActual('argon2');
  return { ...actual, verify: jest.fn(actual.verify) };
});
const verify = argon2.verify as jest.MockedFunction<typeof argon2.verify>;

/**
 * A device's token request has three answers, and a device acts on each
 * differently: a token; 401 DEVICE_REVOKED, meaning these credentials will
 * never work again; and 500, meaning the server couldn't tell. The last used
 * to come back as 401, which told a working iPad it had been revoked.
 */

const SECRET = 'correct-secret';

async function build(opts: { device?: boolean; verify?: typeof argon2.verify } = {}) {
  const secretHash = await argon2.hash(SECRET, { type: argon2.argon2id, memoryCost: 1024, timeCost: 2 });
  const prisma = {
    device: {
      findUnique: async () => (opts.device === false ? null : { id: 'dev-1', orgId: 'org-1', role: 'ski_swap.staff_check_in', secretHash }),
      update: async () => ({}),
    },
  };
  const jwt = { signDeviceToken: async () => 'token-1' };
  const svc = new AuthService(prisma as never, jwt as never, {} as never, {} as never, {} as never, {} as never);
  if (opts.verify) verify.mockImplementationOnce(opts.verify);
  return svc;
}

beforeEach(() => verify.mockClear());

describe('a device asking for a token', () => {
  it('gets one for its credentials', async () => {
    const svc = await build();
    await expect(svc.getDeviceToken('client-1', SECRET)).resolves.toEqual({ accessToken: 'token-1', tokenType: 'Bearer' });
  });

  it('is told DEVICE_REVOKED when its secret was replaced', async () => {
    const svc = await build();
    const err = (await svc.getDeviceToken('client-1', 'old-secret').catch((e: unknown) => e)) as HttpException;
    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  it('is told DEVICE_REVOKED when it was deleted, the same way', async () => {
    const svc = await build({ device: false });
    const err = (await svc.getDeviceToken('gone', SECRET).catch((e: unknown) => e)) as HttpException;
    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  it('is told 500, not revoked, when the secret check itself fails', async () => {
    const svc = await build({ verify: async () => { throw new Error('Memory allocation failed'); } });
    const err = (await svc.getDeviceToken('client-1', SECRET).catch((e: unknown) => e)) as HttpException;
    expect(err.getStatus()).toBe(500);
    expect(JSON.stringify(err.getResponse())).not.toContain('DEVICE_REVOKED');
  });

  it('checks an unknown device against a real hash, so it takes as long as a wrong secret', async () => {
    const svc = await build({ device: false });
    await svc.getDeviceToken('gone', SECRET).catch(() => undefined);
    const [hash] = verify.mock.calls[0];
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  });
});
