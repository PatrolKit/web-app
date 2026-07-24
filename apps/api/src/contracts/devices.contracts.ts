import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PermissionKeySchema } from './org.contracts';

// ─── Provision request / response ────────────────────────────────────────────

export const ProvisionDeviceSchema = z
  .object({
    name: z.string().min(1).max(100),
    permissions: z.array(PermissionKeySchema).default([]),
  })
  .strict();

export const ProvisionDeviceResponseSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  clientSecret: z.string(), // present ONLY in provision + rotate responses
  name: z.string(),
  orgId: z.string(),
  status: z.string(),
  permissions: z.array(PermissionKeySchema),
  createdAt: z.date(),
});

// ─── List response ────────────────────────────────────────────────────────────

export const DeviceListItemSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  orgId: z.string(),
  status: z.string(),
  permissions: z.array(PermissionKeySchema),
  lastSeenAt: z.date().nullable(),
  createdAt: z.date(),
});

// ─── Device token ─────────────────────────────────────────────────────────────

export const DeviceTokenResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
});

// ─── DTOs ────────────────────────────────────────────────────────────────────

export class ProvisionDeviceDto extends createZodDto(ProvisionDeviceSchema) {}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProvisionDeviceRequest = z.infer<typeof ProvisionDeviceSchema>;
export type ProvisionDeviceResponse = z.infer<typeof ProvisionDeviceResponseSchema>;
export type DeviceListItem = z.infer<typeof DeviceListItemSchema>;
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;
