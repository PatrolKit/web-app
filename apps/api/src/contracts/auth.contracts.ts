import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const MagicLinkRequestSchema = z
  .object({ email: z.string().trim().toLowerCase().email() })
  .strict();

export const MagicLinkVerifySchema = z
  .object({ token: z.string().min(1).max(512) })
  .strict();

export const AuthTokenResponseSchema = z.object({
  accessToken: z.string(),
});

export const DeviceTokenRequestSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  })
  .strict();

// ─── NestJS DTOs ──────────────────────────────────────────────────────────────

export class MagicLinkRequestDto extends createZodDto(MagicLinkRequestSchema) {}
export class MagicLinkVerifyDto extends createZodDto(MagicLinkVerifySchema) {}
export class DeviceTokenRequestDto extends createZodDto(DeviceTokenRequestSchema) {}

// ─── TypeScript types (imported by the web app via path alias) ────────────────

export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>;
export type MagicLinkVerify = z.infer<typeof MagicLinkVerifySchema>;
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequestSchema>;
