import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// ─── Role enumeration ─────────────────────────────────────────────────────────

export const DeviceRoleSchema = z.enum([
  'Ski Swap - Check-In',
  'Ski Swap - Bulk Seller',
  'Time Clock',
]);
export type DeviceRole = z.infer<typeof DeviceRoleSchema>;

// ─── Provision request / response ────────────────────────────────────────────

export const ProvisionDeviceSchema = z
  .object({
    name: z.string().min(1).max(100),
    role: DeviceRoleSchema,
  })
  .strict();

export const ProvisionDeviceResponseSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  clientSecret: z.string(), // present ONLY in provision + rotate responses
  name: z.string(),
  role: DeviceRoleSchema,
  orgId: z.string(),
  createdAt: z.date(),
});

// ─── List response ────────────────────────────────────────────────────────────

export const DeviceListItemSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  role: DeviceRoleSchema,
  orgId: z.string(),
  lastSeenAt: z.date().nullable(),
  createdAt: z.date(),
});

// ─── Device token ─────────────────────────────────────────────────────────────

export const DeviceTokenResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
});

// ─── Device me ───────────────────────────────────────────────────────────────

export const DeviceMeResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: DeviceRoleSchema,
  orgId: z.string(),
  orgName: z.string(),
  skiSwapDeviceCode: z.string().nullable(),
  sellerSiteUrl: z.string(),
  orgLogoUrl: z.string().nullable().optional(),
});

// ─── DTOs ────────────────────────────────────────────────────────────────────

export class ProvisionDeviceDto extends createZodDto(ProvisionDeviceSchema) {}
export class UpdateDeviceDto extends createZodDto(
  z.object({ role: DeviceRoleSchema }).strict(),
) {}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProvisionDeviceRequest = z.infer<typeof ProvisionDeviceSchema>;
export type ProvisionDeviceResponse = z.infer<typeof ProvisionDeviceResponseSchema>;
export type DeviceListItem = z.infer<typeof DeviceListItemSchema>;
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;
export type DeviceMeResponse = z.infer<typeof DeviceMeResponseSchema>;
export type UpdateDeviceRequest = { role: DeviceRole };
