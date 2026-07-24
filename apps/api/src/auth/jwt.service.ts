import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';
import { generateKeyPairSync } from 'crypto';
import type { KeyLike } from 'jose';

export interface AccessTokenPayload {
  sub: string; // userId
}

export interface DeviceTokenPayload {
  sub: string; // clientId
  deviceId: string;
  orgId: string;
  permissions: string[];
}

const PLACEHOLDER = 'REPLACE_WITH_BASE64_ED25519_PRIVATE_KEY_PEM';

@Injectable()
export class JwtService implements OnModuleInit {
  private readonly logger = new Logger(JwtService.name);
  private privateKey!: KeyLike;
  private publicKey!: KeyLike;
  private accessTtl!: number;
  private deviceTtl!: number;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const privateB64 = this.config.get<string>('app.jwtPrivateKey', '');
    const publicB64 = this.config.get<string>('app.jwtPublicKey', '');
    const isProduction = this.config.get<string>('app.nodeEnv') === 'production';

    if (!privateB64 || privateB64 === PLACEHOLDER) {
      if (isProduction) {
        throw new Error('JWT_PRIVATE_KEY must be set in production');
      }
      // Dev: generate ephemeral keys — tokens are lost on restart
      this.logger.warn(
        'JWT_PRIVATE_KEY not configured — using ephemeral Ed25519 keys (dev only). ' +
          'Run: node scripts/gen-keys.mjs to generate persistent keys.',
      );
      const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      this.privateKey = await importPKCS8(privateKey, 'EdDSA');
      this.publicKey = await importSPKI(publicKey, 'EdDSA');
    } else {
      const privatePem = Buffer.from(privateB64, 'base64').toString('utf8');
      const publicPem = Buffer.from(publicB64, 'base64').toString('utf8');
      this.privateKey = await importPKCS8(privatePem, 'EdDSA');
      this.publicKey = await importSPKI(publicPem, 'EdDSA');
    }

    this.accessTtl = this.config.get<number>('app.accessTokenTtl', 900);
    this.deviceTtl = this.config.get<number>('app.deviceTokenTtl', 3600);
  }

  async signAccessToken(userId: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtl}s`)
      .sign(this.privateKey);
  }

  async signDeviceToken(payload: {
    sub: string;
    deviceId: string;
    orgId: string;
    permissions: string[];
  }): Promise<string> {
    return new SignJWT({
      deviceId: payload.deviceId,
      orgId: payload.orgId,
      permissions: payload.permissions,
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(payload.sub)
      .setIssuedAt()
      .setExpirationTime(`${this.deviceTtl}s`)
      .sign(this.privateKey);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    const { payload } = await jwtVerify(token, this.publicKey, { algorithms: ['EdDSA'] });
    if (!payload.sub) throw new Error('Token missing sub claim');
    return { sub: payload.sub };
  }

  async verifyDeviceToken(token: string): Promise<DeviceTokenPayload> {
    const { payload } = await jwtVerify(token, this.publicKey, { algorithms: ['EdDSA'] });
    return {
      sub: payload.sub as string,
      deviceId: payload['deviceId'] as string,
      orgId: payload['orgId'] as string,
      permissions: payload['permissions'] as string[],
    };
  }
}
