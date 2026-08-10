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
  'devices:read',
  'devices:provision',
  'devices:revoke',
  'ski_swap:report',
  'ski_swap:manage',
  'ski_swap:admin',
  'business_seller',
]);

export type PermissionKey = z.infer<typeof PermissionKeySchema>;

export const ALL_PERMISSION_KEYS: PermissionKey[] = PermissionKeySchema.options;

// ─── /me schemas ─────────────────────────────────────────────────────────────

export const MembershipSummarySchema = z.object({
  orgId: z.string(),
  orgName: z.string(),
  orgSlug: z.string(),
  status: z.string(),
  permissions: z.array(PermissionKeySchema),
});

export const MeResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  isSuperAdmin: z.boolean(),
  memberships: z.array(MembershipSummarySchema),
});

export const PatchMeSchema = z.object({ name: z.string().min(1).max(100) }).strict();

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
  modules: z.array(OrgModuleSummarySchema),
});

export const PatchOrgSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: 'At least one field must be provided',
  });

// ─── NestJS DTOs ──────────────────────────────────────────────────────────────

export class PatchMeDto extends createZodDto(PatchMeSchema) {}
export class PatchOrgDto extends createZodDto(PatchOrgSchema) {}

// ─── Types ───────────────────────────────────────────────────────────────────

export type MembershipSummary = z.infer<typeof MembershipSummarySchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type OrgResponse = z.infer<typeof OrgResponseSchema>;
export type PatchMeRequest = z.infer<typeof PatchMeSchema>;
export type PatchOrgRequest = z.infer<typeof PatchOrgSchema>;
