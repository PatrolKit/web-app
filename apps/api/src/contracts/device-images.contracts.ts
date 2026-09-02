import { z } from 'zod';

/**
 * Device images, as published to S3 by the device-image repo.
 *
 * The shape is `tools/publish-image.sh`'s, not ours — that script writes
 * `index.json` and this reads it. Parsed rather than trusted so a malformed or
 * half-written index surfaces as an error here instead of an empty download
 * page nobody can explain.
 */

export const DeviceImageEntrySchema = z.object({
  /** The image config's name, e.g. `patrolkit-device`. */
  name: z.string().min(1),
  version: z.string().min(1),
  /** S3 key. Never sent to the browser — it is what gets presigned. */
  key: z.string().min(1),
  filename: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive(),
  gitSha: z.string().default(''),
  builtAt: z.string(),
  /** Fingerprints of the apt signing keys this image will trust. */
  trustedKeys: z.array(z.string()).default([]),
  notes: z.string().default(''),
});

export const DeviceImageIndexSchema = z.object({
  images: z.array(DeviceImageEntrySchema),
});

/** What the browser gets: the same entry minus the S3 key. */
export const DeviceImageResponseSchema = DeviceImageEntrySchema.omit({ key: true });

export type DeviceImageEntry = z.infer<typeof DeviceImageEntrySchema>;
export type DeviceImageResponse = z.infer<typeof DeviceImageResponseSchema>;

export interface DeviceImageDownload {
  /** Presigned, time-limited, and good for exactly one object. */
  url: string;
  expiresInSec: number;
  filename: string;
  sha256: string;
  sizeBytes: number;
}
