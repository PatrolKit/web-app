import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * What a sign-in was for, so the flow survives it.
 *
 * Structured and server-interpreted, never a URL: a stored redirect target
 * confirmed in a different tab is an open redirect with extra steps. Confirm
 * hands these ids back and the client decides what to render.
 *
 * `{ swapId, stationId }` is check-in; other flows may add their own shapes.
 */
export const SignInContextSchema = z
  .object({
    swapId: z.string().min(1),
    stationId: z.string().min(1),
  })
  .strict();

/**
 * One login endpoint, two channels. Exactly one of email/phone must be given —
 * the channel chosen here decides whether a magic link or an OTP is sent.
 */
export const LoginRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().optional(),
    phone: z.string().trim().min(7).max(32).optional(),
    context: SignInContextSchema.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.email) !== Boolean(v.phone), {
    message: 'Provide exactly one of email or phone',
  });

export const ChallengeConfirmSchema = z
  .object({ code: z.string().trim().min(1).max(512) })
  .strict();

export const LoginResponseSchema = z.object({
  queued: z.literal(true),
  /** Null when the person does not exist — deliberately indistinguishable from success. */
  challengeId: z.string().nullable(),
  channel: z.enum(['email', 'phone']).nullable(),
  /** Present only when OUTBOUND_NOTIFICATIONS is off, so dev can complete the flow. */
  devCode: z.string().optional(),
});

export const AuthTokenResponseSchema = z.object({
  accessToken: z.string().nullable(),
  verified: z.literal(true),
  /**
   * Whatever the sign-in was for, handed back for the client to act on. Null
   * for an ordinary sign-in. Returned rather than redirected to, deliberately.
   */
  context: SignInContextSchema.nullable().optional(),
});

export const DeviceTokenRequestSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  })
  .strict();

// ─── NestJS DTOs ──────────────────────────────────────────────────────────────

export class LoginRequestDto extends createZodDto(LoginRequestSchema) {}
export class ChallengeConfirmDto extends createZodDto(ChallengeConfirmSchema) {}
export class DeviceTokenRequestDto extends createZodDto(DeviceTokenRequestSchema) {}

// ─── TypeScript types (imported by the web app via path alias) ────────────────

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type SignInContext = z.infer<typeof SignInContextSchema>;
export type ChallengeConfirm = z.infer<typeof ChallengeConfirmSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequestSchema>;
