import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { generateKeyPairSync } from 'crypto';
import { JwtService } from '../../auth/jwt.service';

async function makeJwtService() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const svc = new JwtService({
    get: (key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = {
        'app.jwtPrivateKey': Buffer.from(privateKey).toString('base64'),
        'app.jwtPublicKey': Buffer.from(publicKey).toString('base64'),
        'app.nodeEnv': 'test',
        'app.accessTokenTtl': 900,
        'app.deviceTokenTtl': 3600,
      };
      return map[key] ?? fallback;
    },
  } as never);
  await svc.onModuleInit();
  return { svc, privateKey, publicKey };
}

function makeCtx(authHeader?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: authHeader }, user: undefined }),
    }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: JwtService;

  beforeAll(async () => {
    const { svc } = await makeJwtService();
    jwtService = svc;
    guard = new JwtAuthGuard(jwtService);
  });

  it('allows a valid bearer token and sets req.user', async () => {
    const token = await jwtService.signAccessToken('user-abc');
    const req = { headers: { authorization: `Bearer ${token}` }, user: undefined };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect((req as { user?: { userId: string } }).user?.userId).toBe('user-abc');
  });

  it('throws 401 when no Authorization header', async () => {
    await expect(guard.canActivate(makeCtx())).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 for a tampered token', async () => {
    const token = await jwtService.signAccessToken('user-xyz');
    const bad = token.slice(0, -4) + 'xxxx';
    await expect(guard.canActivate(makeCtx(`Bearer ${bad}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 401 for a non-Bearer prefix', async () => {
    await expect(guard.canActivate(makeCtx('Token abc'))).rejects.toThrow(UnauthorizedException);
  });
});
