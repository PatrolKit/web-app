import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PermissionKeySchema } from './org.contracts';

// ─── Members ─────────────────────────────────────────────────────────────────

export const MemberResponseSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  status: z.string(),
  joinedAt: z.date(),
  permissions: z.array(PermissionKeySchema),
});

export const InviteMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    name: z.string().min(1).max(100).optional(),
    permissions: z.array(PermissionKeySchema).default([]),
  })
  .strict();

export const UpdateMemberSchema = z
  .object({
    status: z.enum(['active', 'disabled']).optional(),
    permissions: z.array(PermissionKeySchema).optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.permissions !== undefined, {
    message: 'At least one field must be provided',
  });

// ─── Bulk import ─────────────────────────────────────────────────────────────

export const ImportOutcomeSchema = z.object({
  row: z.number(),
  email: z.string(),
  outcome: z.enum(['created', 'already_member', 'invited', 'error']),
  error: z.string().optional(),
});

// ─── Platform org CRUD ───────────────────────────────────────────────────────

export const CreateOrgSchema = z
  .object({
    name: z.string().min(1).max(100),
    slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase, alphanumeric, hyphens only'),
    ownerEmail: z.string().trim().toLowerCase().email(),
  })
  .strict();

export const PlatformOrgResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  createdAt: z.date(),
});

export const PlatformPatchOrgSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: 'At least one field must be provided',
  });

// ─── DTOs ────────────────────────────────────────────────────────────────────

export class InviteMemberDto extends createZodDto(InviteMemberSchema) {}
export class UpdateMemberDto extends createZodDto(UpdateMemberSchema) {}
export class CreateOrgDto extends createZodDto(CreateOrgSchema) {}
export class PlatformPatchOrgDto extends createZodDto(PlatformPatchOrgSchema) {}

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemberResponse = z.infer<typeof MemberResponseSchema>;
export type InviteMemberRequest = z.infer<typeof InviteMemberSchema>;
export type UpdateMemberRequest = z.infer<typeof UpdateMemberSchema>;
export type ImportOutcome = z.infer<typeof ImportOutcomeSchema>;
export type CreateOrgRequest = z.infer<typeof CreateOrgSchema>;
export type PlatformOrgResponse = z.infer<typeof PlatformOrgResponseSchema>;
export type PlatformPatchOrgRequest = z.infer<typeof PlatformPatchOrgSchema>;
