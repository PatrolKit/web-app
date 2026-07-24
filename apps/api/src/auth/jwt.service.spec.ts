import { generateKeyPairSync } from 'crypto';
import { importPKCS8, importSPKI } from 'jose';
import { JwtService } from './jwt.service';

async function buildService(): Promise<JwtService> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const privateB64 = Buffer.from(privateKey).toString('base64');
  const publicB64 = Buffer.from(publicKey).toString('base64');

  const config = {
    get: (key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = {
        'app.jwtPrivateKey': privateB64,
        'app.jwtPublicKey': publicB64,
        'app.nodeEnv': 'test',
        'app.accessTokenTtl': 900,
        'app.deviceTokenTtl': 3600,
      };
      return map[key] ?? fallback;
    },
  } as never;

  const svc = new JwtService(config);
  await svc.onModuleInit();
  return svc;
}

describe('JwtService', () => {
  let svc: JwtService;

  beforeAll(async () => {
    svc = await buildService();
  });

  describe('access token', () => {
    it('round-trips sign/verify', async () => {
      const token = await svc.signAccessToken('user-123');
      const payload = await svc.verifyAccessToken(token);
      expect(payload.sub).toBe('user-123');
    });

    it('rejects a tampered token', async () => {
      const token = await svc.signAccessToken('user-456');
      const [h, p, s] = token.split('.');
      const tampered = `${h}.${p}.${s}x`;
      await expect(svc.verifyAccessToken(tampered)).rejects.toThrow();
    });

    it('uses EdDSA algorithm', async () => {
      const token = await svc.signAccessToken('user-789');
      const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
      expect(header.alg).toBe('EdDSA');
    });
  });

  describe('device token', () => {
    const devicePayload = {
      sub: 'client-id',
      deviceId: 'dev-1',
      orgId: 'org-1',
      permissions: ['devices:read'],
    };

    it('round-trips sign/verify', async () => {
      const token = await svc.signDeviceToken(devicePayload);
      const payload = await svc.verifyDeviceToken(token);
      expect(payload.sub).toBe('client-id');
      expect(payload.deviceId).toBe('dev-1');
      expect(payload.orgId).toBe('org-1');
      expect(payload.permissions).toEqual(['devices:read']);
    });

    it('rejects a token signed by a different key', async () => {
      const otherSvc = await buildService();
      const token = await otherSvc.signDeviceToken(devicePayload);
      await expect(svc.verifyDeviceToken(token)).rejects.toThrow();
    });
  });
});
