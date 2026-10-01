import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// ─── Platform settings (Plan 29) ─────────────────────────────────────────────

export const PlatformSettingsResponseSchema = z.object({
  /** Texting, platform-wide. Off hides and refuses every SMS feature. */
  smsEnabled: z.boolean(),
  updatedAt: z.string(),
  /** Who last changed it, by name. Null before anyone has. */
  updatedBy: z.string().nullable(),
  /**
   * Whether a text would actually leave with the switch on — never the number
   * itself. Off for either means texts are logged, not sent.
   */
  smsReadiness: z.object({
    originationNumber: z.boolean(),
    outboundNotifications: z.boolean(),
  }),
});

export const PatchPlatformSettingsSchema = z.object({ smsEnabled: z.boolean() }).strict();

/** What the signed-out pages need to know: just whether texting is on. */
export const PublicFeaturesResponseSchema = z.object({ sms: z.boolean() });

export class PatchPlatformSettingsDto extends createZodDto(PatchPlatformSettingsSchema) {}

export type PlatformSettingsResponse = z.infer<typeof PlatformSettingsResponseSchema>;
export type PublicFeaturesResponse = z.infer<typeof PublicFeaturesResponseSchema>;
