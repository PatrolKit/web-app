import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { AptIndexService } from './apt-index.service';
import { splitComponents } from './bootstrap.service';
import { DeviceRoleSchema } from '../contracts/devices.contracts';
import type {
  ProfileInput,
  ProfileResponse,
  RepositoryInput,
  RepositoryResponse,
} from '../contracts/bootstrap.contracts';

type RepositoryRow = {
  id: string;
  name: string;
  uri: string;
  suite: string;
  components: string;
  arch: string;
  signedByKeyId: string;
  pinPriority: number | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Configuring what the fleet runs.
 *
 * Every write here is audited without an `orgId`, because there is no org: this
 * is a remote software-installation channel for every device PatrolKit
 * supports, and an unaudited edit to it is the worst kind there is.
 */
@Injectable()
export class BootstrapAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly aptIndex: AptIndexService,
  ) {}

  // ─── Repositories ──────────────────────────────────────────────────────────

  async listRepositories(): Promise<RepositoryResponse[]> {
    const rows = await this.prisma.bootstrapRepository.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toRepositoryResponse);
  }

  async createRepository(data: RepositoryInput, actorUserId: string): Promise<RepositoryResponse> {
    const clash = await this.prisma.bootstrapRepository.findUnique({ where: { name: data.name } });
    if (clash) throw new ConflictException(`A repository named '${data.name}' already exists`);

    const row = await this.prisma.bootstrapRepository.create({
      data: { id: createId(), ...toRepositoryRow(data) },
    });

    await this.audit.log({
      actorType: 'user',
      actorId: actorUserId,
      action: 'bootstrap.repository_created',
      targetType: 'bootstrap_repository',
      targetId: row.id,
      metadata: { ...toRepositoryRow(data) },
    });

    return toRepositoryResponse(row);
  }

  async updateRepository(
    id: string,
    data: RepositoryInput,
    actorUserId: string,
  ): Promise<RepositoryResponse> {
    const existing = await this.prisma.bootstrapRepository.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Repository not found');

    const clash = await this.prisma.bootstrapRepository.findUnique({ where: { name: data.name } });
    if (clash && clash.id !== id) {
      throw new ConflictException(`A repository named '${data.name}' already exists`);
    }

    const row = await this.prisma.bootstrapRepository.update({
      where: { id },
      data: toRepositoryRow(data),
    });

    // The index is keyed by uri/suite/component/arch, so an edit to any of them
    // makes what is cached an answer to a question nobody asked any more.
    this.aptIndex.invalidate();

    await this.audit.log({
      actorType: 'user',
      actorId: actorUserId,
      action: 'bootstrap.repository_updated',
      targetType: 'bootstrap_repository',
      targetId: id,
      metadata: { before: toRepositoryRow(existing), after: toRepositoryRow(data) },
    });

    return toRepositoryResponse(row);
  }

  /**
   * Refused while any profile names it.
   *
   * The relation would simply be dropped, leaving a profile with no
   * repositories — which is not a manifest a device will accept, so every
   * device of that role would silently stop taking updates. Better to make
   * someone detach it deliberately.
   */
  async deleteRepository(id: string, actorUserId: string): Promise<void> {
    const row = await this.prisma.bootstrapRepository.findUnique({
      where: { id },
      include: { profiles: { select: { role: true } } },
    });
    if (!row) throw new NotFoundException('Repository not found');

    if (row.profiles.length > 0) {
      const roles = row.profiles.map((p) => p.role).join(', ');
      throw new ConflictException(`Still in use by: ${roles}. Detach it from those first.`);
    }

    await this.prisma.bootstrapRepository.delete({ where: { id } });
    await this.audit.log({
      actorType: 'user',
      actorId: actorUserId,
      action: 'bootstrap.repository_deleted',
      targetType: 'bootstrap_repository',
      targetId: id,
      metadata: { name: row.name },
    });
  }

  // ─── Profiles ──────────────────────────────────────────────────────────────

  async listProfiles(): Promise<ProfileResponse[]> {
    const rows = await this.prisma.bootstrapProfile.findMany({
      orderBy: { role: 'asc' },
      include: {
        repositories: { orderBy: { name: 'asc' } },
        packages: { orderBy: [{ position: 'asc' }, { name: 'asc' }] },
      },
    });
    return rows.map(toProfileResponse);
  }

  async getProfile(role: string): Promise<ProfileResponse> {
    const row = await this.prisma.bootstrapProfile.findUnique({
      where: { role },
      include: {
        repositories: { orderBy: { name: 'asc' } },
        packages: { orderBy: [{ position: 'asc' }, { name: 'asc' }] },
      },
    });
    if (!row) throw new NotFoundException(`No bootstrap profile for '${role}'`);
    return toProfileResponse(row);
  }

  /**
   * Creates or replaces the profile for one role.
   *
   * A replace rather than a merge, because a profile is small and a partial
   * update of a package list has no obvious meaning — is an omitted package
   * removed, or left alone? Packages that survive keep their `resolvedVersion`,
   * which is the durable fallback for an unreachable index and must not be
   * thrown away by an unrelated edit.
   */
  async upsertProfile(
    role: string,
    data: ProfileInput,
    actorUserId: string,
  ): Promise<ProfileResponse> {
    if (!DeviceRoleSchema.safeParse(role).success) {
      throw new BadRequestException(`'${role}' is not a device role this server issues`);
    }

    const repositories = await this.prisma.bootstrapRepository.findMany({
      where: { id: { in: data.repositoryIds } },
      select: { id: true },
    });
    if (repositories.length !== new Set(data.repositoryIds).size) {
      throw new BadRequestException('One of those repositories does not exist');
    }

    const existing = await this.prisma.bootstrapProfile.findUnique({
      where: { role },
      include: { packages: true },
    });

    await this.prisma.$transaction(async (tx) => {
      const profile = existing
        ? await tx.bootstrapProfile.update({
            where: { role },
            data: {
              deviceType: data.deviceType,
              enabled: data.enabled,
              updateEnabled: data.updateEnabled,
              updateWindow: data.updateWindow,
              checkinIntervalSec: data.checkinIntervalSec,
              // Counts edits. The ETag over the resolved manifest is what
              // devices actually compare, so this moving is a record of who
              // changed what rather than a cache key.
              manifestVersion: { increment: 1 },
              repositories: { set: data.repositoryIds.map((id) => ({ id })) },
            },
          })
        : await tx.bootstrapProfile.create({
            data: {
              id: createId(),
              role,
              deviceType: data.deviceType,
              enabled: data.enabled,
              updateEnabled: data.updateEnabled,
              updateWindow: data.updateWindow,
              checkinIntervalSec: data.checkinIntervalSec,
              repositories: { connect: data.repositoryIds.map((id) => ({ id })) },
            },
          });

      const keep = new Set(data.packages.map((p) => p.name));
      await tx.bootstrapPackage.deleteMany({
        where: { profileId: profile.id, name: { notIn: [...keep] } },
      });

      for (const [position, pkg] of data.packages.entries()) {
        await tx.bootstrapPackage.upsert({
          where: { profileId_name: { profileId: profile.id, name: pkg.name } },
          // `resolvedVersion` is deliberately absent from both branches: a
          // package that survives an edit keeps what tracking last found, and
          // one that becomes pinned keeps it as history nobody reads.
          update: { version: pkg.version, position },
          create: {
            id: createId(),
            profileId: profile.id,
            name: pkg.name,
            version: pkg.version,
            position,
          },
        });
      }
    });

    await this.audit.log({
      actorType: 'user',
      actorId: actorUserId,
      action: existing ? 'bootstrap.profile_updated' : 'bootstrap.profile_created',
      targetType: 'bootstrap_profile',
      targetId: role,
      metadata: {
        before: existing
          ? {
              deviceType: existing.deviceType,
              enabled: existing.enabled,
              updateEnabled: existing.updateEnabled,
              updateWindow: existing.updateWindow,
              checkinIntervalSec: existing.checkinIntervalSec,
              packages: existing.packages.map((p) => ({ name: p.name, version: p.version })),
            }
          : null,
        after: {
          deviceType: data.deviceType,
          enabled: data.enabled,
          updateEnabled: data.updateEnabled,
          updateWindow: data.updateWindow,
          checkinIntervalSec: data.checkinIntervalSec,
          packages: data.packages,
        },
      },
    });

    return this.getProfile(role);
  }
}

function toRepositoryRow(data: RepositoryInput | RepositoryRow) {
  return {
    name: data.name,
    uri: data.uri,
    suite: data.suite,
    components: Array.isArray((data as RepositoryInput).components)
      ? (data as RepositoryInput).components.join(',')
      : (data as RepositoryRow).components,
    arch: data.arch,
    signedByKeyId: data.signedByKeyId,
    pinPriority: data.pinPriority ?? null,
  };
}

function toRepositoryResponse(row: RepositoryRow): RepositoryResponse {
  return {
    id: row.id,
    name: row.name,
    uri: row.uri,
    suite: row.suite,
    components: splitComponents(row.components),
    arch: row.arch as 'arm64' | 'armhf',
    signedByKeyId: row.signedByKeyId,
    pinPriority: row.pinPriority,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProfileResponse(row: {
  id: string;
  role: string;
  deviceType: string;
  enabled: boolean;
  updateEnabled: boolean;
  updateWindow: string | null;
  checkinIntervalSec: number;
  manifestVersion: number;
  updatedAt: Date;
  repositories: RepositoryRow[];
  packages: {
    id: string;
    name: string;
    version: string | null;
    resolvedVersion: string | null;
    resolvedAt: Date | null;
  }[];
}): ProfileResponse {
  return {
    id: row.id,
    role: row.role,
    deviceType: row.deviceType,
    enabled: row.enabled,
    updateEnabled: row.updateEnabled,
    updateWindow: row.updateWindow,
    checkinIntervalSec: row.checkinIntervalSec,
    manifestVersion: row.manifestVersion,
    updatedAt: row.updatedAt,
    repositories: row.repositories.map(toRepositoryResponse),
    packages: row.packages.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      resolvedVersion: p.resolvedVersion,
      resolvedAt: p.resolvedAt,
    })),
  };
}
