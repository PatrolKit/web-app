import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PermissionKeySchema } from './org.contracts';

// ─── Members ─────────────────────────────────────────────────────────────────

export const MemberResponseSchema = z.object({
  userId: z.string(),
  membershipId: z.string(),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  phone: z.string().nullable(),
  phoneVerified: z.boolean(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  displayName: z.string(),
  joinedAt: z.date(),
  /// Soft removal. Null ⇒ live member; set ⇒ removed but retained as a tombstone.
  removedAt: z.date().nullable(),
  /// When the member was last emailed an invite to sign in. Null ⇒ never.
  inviteSentAt: z.date().nullable(),
  permissions: z.array(PermissionKeySchema),
  roles: z.array(z.enum(['seller', 'patroller'])),
});

export const InviteMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().min(7).max(32).optional(),
    permissions: z.array(PermissionKeySchema).default([]),
  })
  .strict();

export const UpdateMemberSchema = z
  .object({
    /// Soft removal, replacing the old active/disabled status: false clears
    /// `deletedAt`, true sets it. The membership row always survives.
    removed: z.boolean().optional(),
    permissions: z.array(PermissionKeySchema).optional(),
  })
  .strict()
  .refine((v) => v.removed !== undefined || v.permissions !== undefined, {
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
// ─── Platform users ──────────────────────────────────────────────────────────

/**
 * Who exists on the platform, across every org.
 *
 * `membership` is the filter that motivated this view: someone can hold a
 * verified contact and no membership anywhere — they signed in, or were part
 * way through a check-in — and until now nothing listed them.
 */
export const PlatformUserQuerySchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    orgId: z.string().optional(),
    membership: z.enum(['any', 'none']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const PlatformUserMembershipSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  orgName: z.string(),
  /**
   * Memberships are soft-deleted, so a former member is distinguishable from
   * someone who never belonged anywhere. Both read as "no org"; only one of
   * them has a story behind it.
   */
  removed: z.boolean(),
});

export const PlatformUserSchema = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  phone: z.string().nullable(),
  phoneVerified: z.boolean(),
  isSuperAdmin: z.boolean(),
  createdAt: z.date(),
  memberships: z.array(PlatformUserMembershipSchema),
});

export const PlatformUserPageSchema = z.object({
  users: z.array(PlatformUserSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

export const AddMembershipSchema = z
  .object({ orgId: z.string().min(1) })
  .strict();

export class PlatformUserQueryDto extends createZodDto(PlatformUserQuerySchema) {}
export class AddMembershipDto extends createZodDto(AddMembershipSchema) {}
export class CreateOrgDto extends createZodDto(CreateOrgSchema) {}
export class PlatformPatchOrgDto extends createZodDto(PlatformPatchOrgSchema) {}

// ─── Types ───────────────────────────────────────────────────────────────────

export type PlatformUserQuery = z.infer<typeof PlatformUserQuerySchema>;
export type PlatformUser = z.infer<typeof PlatformUserSchema>;
export type PlatformUserPage = z.infer<typeof PlatformUserPageSchema>;

export type MemberResponse = z.infer<typeof MemberResponseSchema>;
export type InviteMemberRequest = z.infer<typeof InviteMemberSchema>;
export type UpdateMemberRequest = z.infer<typeof UpdateMemberSchema>;
export type ImportOutcome = z.infer<typeof ImportOutcomeSchema>;
export type CreateOrgRequest = z.infer<typeof CreateOrgSchema>;
export type PlatformOrgResponse = z.infer<typeof PlatformOrgResponseSchema>;
export type PlatformPatchOrgRequest = z.infer<typeof PlatformPatchOrgSchema>;
