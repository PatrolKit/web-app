import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * The bootstrap manifest, and the platform-admin shapes that produce it.
 *
 * Every constraint below is the device's, not ours. `src/patrolkit/manifest.py`
 * in `patrolkit-device-image` validates what it receives and **discards a
 * manifest that fails**, keeping the previous one — so a manifest this server
 * is happy with and the device is not does not produce an error anybody sees.
 * It produces a fleet that quietly stops taking updates.
 *
 * That is why these mirror the device's schema exactly rather than approximately.
 */

// ─── The device's own constraints ────────────────────────────────────────────

/** `[a-z0-9][a-z0-9\-]*`, full match. An apt source name. */
export const RepoNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lower-case letters, digits and hyphens, starting with a letter or digit');

/** `[a-z0-9][a-z0-9+.\-]+`, full match. Note the `+`: one character is not enough. */
export const PackageNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9+.-]+$/, 'A Debian package name: lower-case letters, digits, and + . -');

/**
 * `HH:MM-HH:MM`, and not zero-length.
 *
 * A window whose end precedes its start wraps past midnight and is legal —
 * `22:00-02:00` is a perfectly ordinary maintenance window. Only start == end
 * is refused, because it never occurs.
 */
export const UpdateWindowSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/, 'Must be HH:MM-HH:MM')
  .refine((s) => s.slice(0, 5) !== s.slice(6), 'A window cannot start and end at the same minute');

/**
 * A GPG fingerprint, 8–40 hex digits.
 *
 * Spacing and case are normalised away before comparison on the device, so they
 * are normalised away here too — an operator pasting `A267 DE35 …` out of
 * `gpg --list-keys` should not have to know that.
 */
export const KeyFingerprintSchema = z
  .string()
  .transform((s) => s.replace(/[\s:]/g, '').toUpperCase())
  .pipe(z.string().regex(/^[0-9A-F]{8,40}$/, 'A GPG key fingerprint: 8 to 40 hex digits'));

export const ArchSchema = z.enum(['arm64', 'armhf']);

// ─── The manifest, as served ─────────────────────────────────────────────────

export const ManifestRepositorySchema = z.object({
  name: RepoNameSchema,
  uri: z.string(),
  suite: z.string().min(1),
  components: z.array(z.string().min(1)).min(1),
  arch: ArchSchema,
  signedByKeyId: z.string(),
  pinPriority: z.number().int().min(-1).max(1000).optional(),
});

export const ManifestPackageSchema = z.object({
  name: PackageNameSchema,
  version: z.string().min(1),
});

export const BootstrapManifestSchema = z.object({
  manifestVersion: z.number().int().min(1),
  deviceType: z.string().max(64),
  repositories: z.array(ManifestRepositorySchema).min(1),
  packages: z.array(ManifestPackageSchema).min(1),
  updatePolicy: z
    .object({ enabled: z.boolean(), window: UpdateWindowSchema.optional() })
    .optional(),
  checkinIntervalSec: z.number().int().min(60).max(86400),
});

export type BootstrapManifest = z.infer<typeof BootstrapManifestSchema>;

// ─── Platform admin: repositories ────────────────────────────────────────────

export const RepositoryInputSchema = z
  .object({
    name: RepoNameSchema.max(64),
    /**
     * `https://` only. The device refuses anything else — `file://` is accepted
     * by its validator for the benefit of images with a repository baked in,
     * and is not something this server has any business handing out.
     */
    uri: z.string().url().startsWith('https://', 'Must be an https:// URL').max(512),
    suite: z.string().min(1).max(64),
    components: z.array(z.string().min(1).max(64)).min(1),
    arch: ArchSchema.default('arm64'),
    signedByKeyId: KeyFingerprintSchema,
    pinPriority: z.number().int().min(-1).max(1000).nullable().optional(),
  })
  .strict();

export const RepositoryResponseSchema = RepositoryInputSchema.extend({
  id: z.string(),
  pinPriority: z.number().int().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// ─── Platform admin: profiles ────────────────────────────────────────────────

export const ProfilePackageInputSchema = z
  .object({
    name: PackageNameSchema.max(128),
    /**
     * The pinned version, or null to track the newest the repository carries.
     *
     * Null is the sharper of the two: it makes publishing a `.deb` a deployment,
     * because the manifest changes the moment the index does.
     */
    version: z.string().min(1).max(64).nullable(),
  })
  .strict();

export const ProfileInputSchema = z
  .object({
    deviceType: z.string().min(1).max(64),
    enabled: z.boolean(),
    updateEnabled: z.boolean(),
    updateWindow: UpdateWindowSchema.nullable(),
    checkinIntervalSec: z.number().int().min(60).max(86400),
    /** Repository ids, resolved and rendered in name order. */
    repositoryIds: z.array(z.string().min(1)).min(1),
    packages: z.array(ProfilePackageInputSchema).min(1),
  })
  .strict()
  .refine(
    (p) => new Set(p.packages.map((x) => x.name)).size === p.packages.length,
    { message: 'A package cannot appear twice in one profile', path: ['packages'] },
  );

export const ProfilePackageResponseSchema = ProfilePackageInputSchema.extend({
  id: z.string(),
  /** What tracking last resolved to, and when it was last asked. */
  resolvedVersion: z.string().nullable(),
  resolvedAt: z.date().nullable(),
});

export const ProfileResponseSchema = z.object({
  id: z.string(),
  role: z.string(),
  deviceType: z.string(),
  enabled: z.boolean(),
  updateEnabled: z.boolean(),
  updateWindow: z.string().nullable(),
  checkinIntervalSec: z.number().int(),
  manifestVersion: z.number().int(),
  repositories: z.array(RepositoryResponseSchema),
  packages: z.array(ProfilePackageResponseSchema),
  updatedAt: z.date(),
});

/**
 * Exactly what a device of this role would be served, and the ETag it would be
 * served under.
 *
 * The only way to be sure before a fleet acts on it. `error` carries the reason
 * a manifest cannot currently be produced — an unreachable index with nothing
 * cached — rather than failing the request, because "this is broken right now"
 * is the answer the page exists to give.
 */
export const ManifestPreviewSchema = z.object({
  manifest: BootstrapManifestSchema.nullable(),
  etag: z.string().nullable(),
  error: z.string().nullable(),
});

// ─── DTOs ────────────────────────────────────────────────────────────────────

export class RepositoryInputDto extends createZodDto(RepositoryInputSchema) {}
export class ProfileInputDto extends createZodDto(ProfileInputSchema) {}

// ─── Types ───────────────────────────────────────────────────────────────────

export type RepositoryInput = z.infer<typeof RepositoryInputSchema>;
export type RepositoryResponse = z.infer<typeof RepositoryResponseSchema>;
export type ProfileInput = z.infer<typeof ProfileInputSchema>;
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;
export type ManifestPreview = z.infer<typeof ManifestPreviewSchema>;
