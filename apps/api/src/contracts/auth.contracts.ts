import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * One login endpoint, two channels. Exactly one of email/phone must be given —
 * the channel chosen here decides whether a magic link or an OTP is sent.
 */
export const LoginRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().optional(),
    phone: z.string().trim().min(7).max(32).optional(),
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
export type ChallengeConfirm = z.infer<typeof ChallengeConfirmSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequestSchema>;
