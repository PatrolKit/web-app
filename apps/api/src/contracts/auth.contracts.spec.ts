import {
  MagicLinkRequestSchema,
  MagicLinkVerifySchema,
  AuthTokenResponseSchema,
  DeviceTokenRequestSchema,
} from './auth.contracts';

describe('Auth contracts', () => {
  describe('MagicLinkRequestSchema', () => {
    it('accepts a valid email', () => {
      expect(MagicLinkRequestSchema.safeParse({ email: 'user@example.com' }).success).toBe(true);
    });

    it('lowercases and trims the email', () => {
      const result = MagicLinkRequestSchema.parse({ email: '  USER@EXAMPLE.COM  ' });
      expect(result.email).toBe('user@example.com');
    });

    it('rejects an invalid email', () => {
      expect(MagicLinkRequestSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
    });

    it('rejects unknown fields (strict)', () => {
      expect(
        MagicLinkRequestSchema.safeParse({ email: 'a@b.com', extra: true }).success,
      ).toBe(false);
    });
  });

  describe('MagicLinkVerifySchema', () => {
    it('accepts a token string', () => {
      expect(MagicLinkVerifySchema.safeParse({ token: 'abc123' }).success).toBe(true);
    });

    it('rejects an empty token', () => {
      expect(MagicLinkVerifySchema.safeParse({ token: '' }).success).toBe(false);
    });

    it('rejects tokens over 512 chars', () => {
      expect(MagicLinkVerifySchema.safeParse({ token: 'x'.repeat(513) }).success).toBe(false);
    });

    it('rejects unknown fields', () => {
      expect(MagicLinkVerifySchema.safeParse({ token: 'abc', extra: 1 }).success).toBe(false);
    });
  });

  describe('AuthTokenResponseSchema', () => {
    it('accepts a valid response', () => {
      expect(AuthTokenResponseSchema.safeParse({ accessToken: 'jwt.token.here' }).success).toBe(
        true,
      );
    });
  });

  describe('DeviceTokenRequestSchema', () => {
    it('accepts valid credentials', () => {
      expect(
        DeviceTokenRequestSchema.safeParse({ clientId: 'cid', clientSecret: 'secret' }).success,
      ).toBe(true);
    });

    it('rejects empty clientId', () => {
      expect(
        DeviceTokenRequestSchema.safeParse({ clientId: '', clientSecret: 'secret' }).success,
      ).toBe(false);
    });

    it('rejects unknown fields', () => {
      expect(
        DeviceTokenRequestSchema.safeParse({
          clientId: 'id',
          clientSecret: 's',
          extra: true,
        }).success,
      ).toBe(false);
    });
  });
});
