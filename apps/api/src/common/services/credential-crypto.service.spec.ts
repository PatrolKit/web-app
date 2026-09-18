import { ConfigService } from '@nestjs/config';
import { CredentialCryptoService } from './credential-crypto.service';

const VALID_KEY = 'a'.repeat(64); // 32-byte hex key (all 'a' characters)

function makeService(key: string) {
  const configService = { get: jest.fn().mockReturnValue(key) } as unknown as ConfigService;
  return new CredentialCryptoService(configService);
}

describe('CredentialCryptoService', () => {
  it('encrypts and decrypts a round-trip correctly', () => {
    const svc = makeService(VALID_KEY);
    const plaintext = 'sandbox-access-token-abc123';
    const encrypted = svc.encrypt(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(svc.decrypt(encrypted)).toBe(plaintext);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const svc = makeService(VALID_KEY);
    const a = svc.encrypt('same-token');
    const b = svc.encrypt('same-token');
    expect(a).not.toBe(b);
    expect(svc.decrypt(a)).toBe('same-token');
    expect(svc.decrypt(b)).toBe('same-token');
  });

  it('throws on a missing key', () => {
    expect(() => makeService('')).toThrow('SQUARE_ENCRYPTION_KEY');
  });

  it('throws on a key that is too short', () => {
    expect(() => makeService('a'.repeat(32))).toThrow('SQUARE_ENCRYPTION_KEY');
  });

  it('throws on malformed ciphertext', () => {
    const svc = makeService(VALID_KEY);
    expect(() => svc.decrypt('not-json')).toThrow();
  });
});
