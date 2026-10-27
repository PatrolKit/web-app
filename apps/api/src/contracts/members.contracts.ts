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
  /// What the time clock knows them by (Plan 57). The NSP ID is theirs, set by
  /// the patrol; patrol level is free text.
  nspId: z.string().nullable(),
  patrolLevel: z.string().nullable(),
  /// Still a member, but off the iPad's clock-in list (D5).
  inactive: z.boolean(),
  /// Whether they chose a clock-in PIN. Never the PIN itself (D9).
  clockPinSet: z.boolean(),
  /// Live, not inactive, and an NSP ID or a PIN to verify them by.
  canClockIn: z.boolean(),
  /// Their open shift, so the page can warn before taking them off the clock.
  /// Only on the members list.
  onShift: z.object({ resortName: z.string(), since: z.date() }).nullable().optional(),
  /// When they last signed in or their session was renewed: about every 15
  /// minutes while they use the app, so accurate to 15 minutes. Null ⇒ never.
  /// Only on the members list.
  lastActiveAt: z.date().nullable().optional(),
  /// Whether a session of theirs is still open on some device: signed in, not
  /// signed out, and not expired. Only on the members list.
  signedIn: z.boolean().optional(),
});

/**
 * Contact is optional (Plan 57 D4), but there has to be something to tell two
 * people apart by: an email, a phone or an NSP ID. Without an email there's
 * nobody to invite, so the name is what finds them on the iPad and is required.
 */
export const InviteMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().optional(),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().min(7).max(32).optional(),
    nspId: z.string().trim().min(1).max(32).optional(),
    patrolLevel: z.string().trim().max(60).optional(),
    permissions: z.array(PermissionKeySchema).default([]),
  })
  .strict()
  .refine((v) => v.email || v.phone || v.nspId, {
    message: 'Give an email, a phone number or an NSP ID',
  })
  .refine((v) => v.email || (v.firstName && v.lastName), {
    message: 'Without an email, a first and last name are needed',
  });

export const UpdateMemberSchema = z
  .object({
    /// Soft removal, replacing the old active/disabled status: false clears
    /// `deletedAt`, true sets it. The membership row always survives.
    removed: z.boolean().optional(),
    permissions: z.array(PermissionKeySchema).optional(),
    /// Everything about a person is edited here (Plan 57 D3), by members
    /// managers (D6). Null clears an optional field.
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().toLowerCase().email().nullable().optional(),
    phone: z.string().trim().min(7).max(32).nullable().optional(),
    nspId: z.string().trim().max(32).nullable().optional(),
    patrolLevel: z.string().trim().max(60).nullable().optional(),
    inactive: z.boolean().optional(),
    /// For a member who forgot theirs: they choose a new one on My account.
    clearClockPin: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'At least one field must be provided',
  });

// ─── Bulk import ─────────────────────────────────────────────────────────────

/**
 * One import (Plan 57 D10): the file is parsed and its columns mapped first, so
 * whatever the patrol's NSP export calls them will do, then the mapped rows come
 * back with a strategy for people who are already members.
 */
export const MEMBER_IMPORT_FIELDS = [
  'firstName', 'lastName', 'email', 'phone', 'nspId', 'patrolLevel', 'inactive', 'permissions',
] as const;

export const ImportMembersSchema = z
  .object({
    rows: z
      .array(z.object(Object.fromEntries(MEMBER_IMPORT_FIELDS.map((f) => [f, z.string().nullable().optional()]))))
      .max(5000),
    /// preserve leaves an existing member as they are; overwrite updates their
    /// name, NSP ID, patrol level and inactive from the file.
    strategy: z.enum(['preserve', 'overwrite']).default('preserve'),
    sendInvites: z.boolean().default(false),
  })
  .strict();

export const ImportOutcomeSchema = z.object({
  row: z.number(),
  /// Who the row was: a name, or the contact it gave.
  name: z.string(),
  email: z.string(),
  outcome: z.enum(['created', 'updated', 'already_member', 'invited', 'error']),
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
export class ImportMembersDto extends createZodDto(ImportMembersSchema) {}
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
export type ImportMembersRequest = z.infer<typeof ImportMembersSchema>;
export type CreateOrgRequest = z.infer<typeof CreateOrgSchema>;
export type PlatformOrgResponse = z.infer<typeof PlatformOrgResponseSchema>;

/** A new org, and what happened to its owner: invited like any member (see `inviteMember`). */
export interface CreateOrgResponse extends PlatformOrgResponse {
  owner: {
    email: string;
    /** No PatrolKit account had this email; one was made for them. */
    created: boolean;
    /** Whether the invite email went. Not when outbound mail is off or the provider refused it. */
    invite: 'sent' | 'not_sent';
  };
}
export type PlatformPatchOrgRequest = z.infer<typeof PlatformPatchOrgSchema>;
