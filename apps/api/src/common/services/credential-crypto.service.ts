import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

interface EncryptedPayload {
  iv: string;
  tag: string;
  ct: string;
}

@Injectable()
export class CredentialCryptoService {
  private readonly key: Buffer;

  constructor(private readonly config: ConfigService) {
    const hex = this.config.get<string>('app.squareEncryptionKey') ?? '';
    if (!hex || hex.length !== 64) {
      throw new InternalServerErrorException(
        'SQUARE_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate with: openssl rand -hex 32',
      );
    }
    this.key = Buffer.from(hex, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload: EncryptedPayload = {
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ct: ct.toString('hex'),
    };
    return JSON.stringify(payload);
  }

  decrypt(stored: string): string {
    let payload: EncryptedPayload;
    try {
      payload = JSON.parse(stored) as EncryptedPayload;
    } catch {
      throw new InternalServerErrorException('Invalid encrypted credential format');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(payload.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
    return decipher.update(Buffer.from(payload.ct, 'hex')).toString('utf8') + decipher.final('utf8');
  }
}
