import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// ─── Permission key enum (matches §6 exactly) ─────────────────────────────────

export const PermissionKeySchema = z.enum([
  'org:read',
  'org:manage',
  'modules:manage',
  'users:read',
  'users:invite',
  'users:import',
  'users:manage',
  'permissions:assign',
  'ski_swap:report',
  'ski_swap:manage',
  'ski_swap:admin',
  'time_tracking:report',
  'time_tracking:manage',
  'time_tracking:admin',
  'signage:report',
  'signage:manage',
  'signage:admin',
]);

export type PermissionKey = z.infer<typeof PermissionKeySchema>;

export const ALL_PERMISSION_KEYS: PermissionKey[] = PermissionKeySchema.options;

// ─── /me schemas ─────────────────────────────────────────────────────────────

export const MembershipSummarySchema = z.object({
  orgId: z.string(),
  orgName: z.string(),
  orgSlug: z.string(),
  permissions: z.array(PermissionKeySchema),
  /// Roles held at this org. Derived from live profile rows, not permissions.
  roles: z.array(z.enum(['seller', 'patroller'])),
});

export const MeResponseSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  phone: z.string().nullable(),
  phoneVerified: z.boolean(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  /// Collapsed for display; never empty.
  displayName: z.string(),
  isSuperAdmin: z.boolean(),
  memberships: z.array(MembershipSummarySchema),
});

export const PatchMeSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

// ─── Org schemas ─────────────────────────────────────────────────────────────

export const OrgModuleSummarySchema = z.object({
  key: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  isCore: z.boolean(),
});

export const OrgResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  logoUrl: z.string().url().nullable(),
  modules: z.array(OrgModuleSummarySchema),
});

export const PatchOrgSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    status: z.enum(['active', 'suspended']).optional(),
    slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers, and hyphens').optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.status !== undefined || v.slug !== undefined, {
    message: 'At least one field must be provided',
  });

// ─── Resorts ─────────────────────────────────────────────────────────────────

/**
 * Address is optional so existing resorts stay valid, but supplying it is what
 * lets the server derive `timeZone`. `timeZone` is only accepted as an explicit
 * override when the derivation gets it wrong.
 */
const ResortAddressShape = {
  street: z.string().max(120).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  state: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'State must be a two-letter abbreviation')
    .nullable()
    .optional(),
  zip: z
    .string()
    .regex(/^\d{5}(-\d{4})?$/, 'ZIP must be 5 digits, optionally ZIP+4')
    .nullable()
    .optional(),
  timeZone: z.string().min(1).max(64).optional(),
};

export const CreateResortSchema = z
  .object({ name: z.string().min(1).max(100), ...ResortAddressShape })
  .strict();

export const PatchResortSchema = z
  .object({ name: z.string().min(1).max(100).optional(), ...ResortAddressShape })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const ResortResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  timeZone: z.string(),
  updatedAt: z.string(),
});

// ─── NestJS DTOs ──────────────────────────────────────────────────────────────

export class PatchMeDto extends createZodDto(PatchMeSchema) {}
export class PatchOrgDto extends createZodDto(PatchOrgSchema) {}
export class CreateResortDto extends createZodDto(CreateResortSchema) {}
export class PatchResortDto extends createZodDto(PatchResortSchema) {}

// ─── Types ───────────────────────────────────────────────────────────────────

export type MembershipSummary = z.infer<typeof MembershipSummarySchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type OrgResponse = z.infer<typeof OrgResponseSchema>;
export type PatchMeRequest = z.infer<typeof PatchMeSchema>;
export type PatchOrgRequest = z.infer<typeof PatchOrgSchema>;
export type ResortResponse = z.infer<typeof ResortResponseSchema>;
export type CreateResortRequest = z.infer<typeof CreateResortSchema>;
export type PatchResortRequest = z.infer<typeof PatchResortSchema>;
