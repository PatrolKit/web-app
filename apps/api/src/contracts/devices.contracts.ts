import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PermissionKeySchema } from './org.contracts';

// ─── Role enumeration ─────────────────────────────────────────────────────────

export const DeviceRoleSchema = z.enum(['Ski Swap - Check-In', 'Ski Swap - Bulk Seller']);
export type DeviceRole = z.infer<typeof DeviceRoleSchema>;

// ─── Provision request / response ────────────────────────────────────────────

export const ProvisionDeviceSchema = z
  .object({
    name: z.string().min(1).max(100),
    role: DeviceRoleSchema,
    permissions: z.array(PermissionKeySchema).default([]),
  })
  .strict();

export const ProvisionDeviceResponseSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  clientSecret: z.string(), // present ONLY in provision + rotate responses
  name: z.string(),
  role: DeviceRoleSchema,
  orgId: z.string(),
  permissions: z.array(PermissionKeySchema),
  createdAt: z.date(),
});

// ─── List response ────────────────────────────────────────────────────────────

export const DeviceListItemSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  role: DeviceRoleSchema,
  orgId: z.string(),
  permissions: z.array(PermissionKeySchema),
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
  permissions: z.array(z.string()),
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
