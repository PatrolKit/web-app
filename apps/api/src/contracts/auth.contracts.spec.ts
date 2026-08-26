import {
  LoginRequestSchema,
  ChallengeConfirmSchema,
  AuthTokenResponseSchema,
  DeviceTokenRequestSchema,
  SignInContextSchema,
} from './auth.contracts';

describe('Auth contracts', () => {
  describe('LoginRequestSchema', () => {
    it('accepts a valid email', () => {
      expect(LoginRequestSchema.safeParse({ email: 'user@example.com' }).success).toBe(true);
    });

    it('accepts a phone number', () => {
      expect(LoginRequestSchema.safeParse({ phone: '+15550101001' }).success).toBe(true);
    });

    it('lowercases and trims the email', () => {
      const result = LoginRequestSchema.parse({ email: '  USER@EXAMPLE.COM  ' });
      expect(result.email).toBe('user@example.com');
    });

    it('rejects an invalid email', () => {
      expect(LoginRequestSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
    });

    // Exactly one channel — the choice is what decides link vs OTP.
    it('rejects both channels at once', () => {
      expect(
        LoginRequestSchema.safeParse({ email: 'a@b.com', phone: '+15550101001' }).success,
      ).toBe(false);
    });

    it('rejects neither channel', () => {
      expect(LoginRequestSchema.safeParse({}).success).toBe(false);
    });

    it('rejects unknown fields (strict)', () => {
      expect(LoginRequestSchema.safeParse({ email: 'a@b.com', extra: true }).success).toBe(false);
    });

    it('carries a sign-in context', () => {
      const result = LoginRequestSchema.safeParse({
        email: 'a@b.com',
        context: { swapId: 'swap1', stationId: 'station1' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('SignInContextSchema', () => {
    it('accepts a swap and station pair', () => {
      expect(
        SignInContextSchema.safeParse({ swapId: 's', stationId: 't' }).success,
      ).toBe(true);
    });

    // The whole point of ids over a URL: nothing here can name a destination.
    it('rejects a URL smuggled in as an extra field', () => {
      expect(
        SignInContextSchema.safeParse({
          swapId: 's',
          stationId: 't',
          redirect: 'https://evil.example.com',
        }).success,
      ).toBe(false);
    });

    it('rejects a partial pair', () => {
      expect(SignInContextSchema.safeParse({ swapId: 's' }).success).toBe(false);
    });
  });

  describe('ChallengeConfirmSchema', () => {
    it('accepts a code string', () => {
      expect(ChallengeConfirmSchema.safeParse({ code: 'abc123' }).success).toBe(true);
    });

    it('rejects an empty code', () => {
      expect(ChallengeConfirmSchema.safeParse({ code: '' }).success).toBe(false);
    });

    it('rejects codes over 512 chars', () => {
      expect(ChallengeConfirmSchema.safeParse({ code: 'x'.repeat(513) }).success).toBe(false);
    });

    it('rejects unknown fields', () => {
      expect(ChallengeConfirmSchema.safeParse({ code: 'abc', extra: 1 }).success).toBe(false);
    });
  });

  describe('AuthTokenResponseSchema', () => {
    it('accepts a session-minting response', () => {
      expect(
        AuthTokenResponseSchema.safeParse({ accessToken: 'jwt.token.here', verified: true }).success,
      ).toBe(true);
    });

    // A bare `verify` challenge proves the contact without minting a session.
    it('accepts a verify-only response', () => {
      expect(AuthTokenResponseSchema.safeParse({ accessToken: null, verified: true }).success).toBe(
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
