import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AptIndexService, type RepositoryCoordinates } from './apt-index.service';
import type { BootstrapManifest, ManifestPreview } from '../contracts/bootstrap.contracts';

/** What a device told us about itself on the way in. */
export interface DeviceFacts {
  hardwareId: string | null;
  imageName: string | null;
  imageVersion: string | null;
  installedPackages: string | null;
}

/** A manifest and the ETag it is served under. */
export interface ResolvedManifest {
  manifest: BootstrapManifest;
  etag: string;
}

/**
 * How stale a persisted `resolvedVersion` may be before it is written again.
 *
 * The index itself is cached for five minutes, so resolution only genuinely
 * happens that often; without this the row would still be written on every
 * check-in of every device, which is a write per device per hour to store a
 * value that did not change.
 */
const RESOLVE_PERSIST_MS = 5 * 60_000;

@Injectable()
export class BootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aptIndex: AptIndexService,
  ) {}

  /**
   * What a device of this role should be running.
   *
   * Throws `NotFoundException` for a role nobody has configured, which a device
   * answers by keeping the manifest it already has — the right behaviour, and
   * the reason a missing profile is not an error worth escalating.
   */
  async manifestForRole(role: string): Promise<ResolvedManifest> {
    const profile = await this.prisma.bootstrapProfile.findUnique({
      where: { role },
      include: {
        repositories: { orderBy: { name: 'asc' } },
        packages: { orderBy: [{ position: 'asc' }, { name: 'asc' }] },
      },
    });

    if (!profile || !profile.enabled) {
      throw new NotFoundException(`No bootstrap profile is configured for '${role}'`);
    }

    const coordinates: RepositoryCoordinates[] = profile.repositories.map((r) => ({
      uri: r.uri,
      suite: r.suite,
      components: splitComponents(r.components),
      arch: r.arch,
    }));

    const packages: { name: string; version: string }[] = [];
    for (const pkg of profile.packages) {
      packages.push({ name: pkg.name, version: await this.resolveVersion(pkg, coordinates) });
    }

    const manifest: BootstrapManifest = {
      manifestVersion: profile.manifestVersion,
      deviceType: profile.deviceType,
      repositories: profile.repositories.map((r) => ({
        name: r.name,
        uri: r.uri,
        suite: r.suite,
        components: splitComponents(r.components),
        arch: r.arch as 'arm64' | 'armhf',
        signedByKeyId: r.signedByKeyId,
        ...(r.pinPriority === null ? {} : { pinPriority: r.pinPriority }),
      })),
      packages,
      updatePolicy: {
        enabled: profile.updateEnabled,
        ...(profile.updateWindow ? { window: profile.updateWindow } : {}),
      },
      checkinIntervalSec: profile.checkinIntervalSec,
    };

    return { manifest, etag: etagFor(manifest) };
  }

  /** The same answer, with the failure reported rather than thrown (admin preview). */
  async previewForRole(role: string): Promise<ManifestPreview> {
    try {
      const { manifest, etag } = await this.manifestForRole(role);
      return { manifest, etag, error: null };
    } catch (err) {
      if (err instanceof NotFoundException || err instanceof ServiceUnavailableException) {
        return { manifest: null, etag: null, error: err.message };
      }
      throw err;
    }
  }

  /**
   * What the device said about itself, recorded.
   *
   * Written on every fetch including the ones answered `304`: steady state is
   * almost entirely 304s, so a check-in that only counted on `200` would make a
   * healthy fleet look like it had stopped calling in.
   *
   * Nothing here is validated. It is telemetry, not authorization — a device
   * that lies about its image version misleads a page, and a device that lies
   * about its credentials never got this far.
   */
  async recordCheckIn(deviceId: string, facts: DeviceFacts): Promise<void> {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        hardwareId: facts.hardwareId ?? undefined,
        imageName: facts.imageName ?? undefined,
        imageVersion: facts.imageVersion ?? undefined,
        installedPackages: facts.installedPackages ?? undefined,
        bootstrapAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
  }

  /**
   * A pinned package resolves to itself; a tracking one asks the repository.
   *
   * A tracking package that cannot be resolved and has never been resolved
   * fails the whole request rather than being dropped from the manifest. A
   * manifest missing a package installs nothing and uninstalls nothing, and
   * looks exactly like success.
   */
  private async resolveVersion(
    pkg: { id: string; name: string; version: string | null; resolvedVersion: string | null; resolvedAt: Date | null },
    repositories: RepositoryCoordinates[],
  ): Promise<string> {
    if (pkg.version) return pkg.version;

    const newest = await this.aptIndex.newestVersionOf(pkg.name, repositories);

    if (newest) {
      const stale = !pkg.resolvedAt || Date.now() - pkg.resolvedAt.getTime() > RESOLVE_PERSIST_MS;
      if (newest !== pkg.resolvedVersion || stale) {
        await this.prisma.bootstrapPackage.update({
          where: { id: pkg.id },
          data: { resolvedVersion: newest, resolvedAt: new Date() },
        });
      }
      return newest;
    }

    if (pkg.resolvedVersion) return pkg.resolvedVersion;

    throw new ServiceUnavailableException(
      `Cannot determine a version for '${pkg.name}': its repository is unreachable and nothing has been resolved before`,
    );
  }
}

/** `"main,contrib"` → `['main', 'contrib']`. */
export function splitComponents(components: string): string[] {
  return components
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * The ETag over the resolved manifest.
 *
 * Deliberately the same construction the image repo's mock bootstrap server
 * uses — sha256 of the canonical JSON, first 16 hex digits, quoted — so the
 * bench fixture and production agree on what "unchanged" means.
 *
 * Over the *resolved* bytes rather than over `manifestVersion`, because a
 * package that tracks latest changes what is served with no edit behind it.
 */
export function etagFor(manifest: BootstrapManifest): string {
  const digest = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
  return `"${digest.slice(0, 16)}"`;
}

/**
 * JSON with object keys in sorted order, so two runs that mean the same thing
 * hash the same. Array order is preserved — it is meaningful.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
