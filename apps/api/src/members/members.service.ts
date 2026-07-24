import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { PermissionsService } from '../permissions/permissions.service';
import { createId } from '@paralleldrive/cuid2';
import { parse } from 'csv-parse/sync';
import type {
  MemberResponse,
  InviteMemberRequest,
  UpdateMemberRequest,
  ImportOutcome,
} from '../contracts/members.contracts';
import { ALL_PERMISSION_KEYS, type PermissionKey } from '../contracts/org.contracts';

const MAX_CSV_ROWS = 500;

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly permissionsService: PermissionsService,
  ) {}

  // ─── List ─────────────────────────────────────────────────────────────────

  async listMembers(orgId: string): Promise<MemberResponse[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { orgId },
      include: { user: true, permissions: { include: { permission: true } } },
      orderBy: { joinedAt: 'asc' },
    });

    return memberships.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      status: m.status,
      joinedAt: m.joinedAt,
      permissions: m.permissions.map((mp) => mp.permission.key as PermissionKey),
    }));
  }

  // ─── Single invite ────────────────────────────────────────────────────────

  async inviteMember(
    orgId: string,
    inviterUserId: string,
    data: InviteMemberRequest,
  ): Promise<MemberResponse> {
    let user = await this.prisma.user.findUnique({ where: { email: data.email } });

    if (user) {
      // Check existing membership
      const existing = await this.prisma.membership.findUnique({
        where: { userId_orgId: { userId: user.id, orgId } },
      });
      if (existing && existing.status === 'active') {
        throw new ConflictException('User is already an active member');
      }
    } else {
      user = await this.prisma.user.create({
        data: { id: createId(), email: data.email, name: data.name ?? data.email.split('@')[0] },
      });
    }

    const membership = await this.prisma.membership.upsert({
      where: { userId_orgId: { userId: user.id, orgId } },
      update: { status: 'active' },
      create: { id: createId(), userId: user.id, orgId, status: 'active' },
    });

    if (data.permissions.length > 0) {
      await this.assignPermissions(membership.id, data.permissions as PermissionKey[]);
    }

    this.permissionsService.invalidate(user.id, orgId);

    // Send magic-link onboarding (fire-and-forget)
    this.authService.requestMagicLink(user.email).catch(() => {});

    return this.getMemberResponse(membership.id);
  }

  // ─── Bulk CSV import ──────────────────────────────────────────────────────

  async bulkImport(
    orgId: string,
    csvBuffer: Buffer,
    sendInvites: boolean,
  ): Promise<ImportOutcome[]> {
    let rows: Record<string, string>[];
    try {
      rows = parse(csvBuffer, { columns: true, skip_empty_lines: true, trim: true }) as Record<
        string,
        string
      >[];
    } catch {
      throw new BadRequestException('Invalid CSV file');
    }

    if (rows.length > MAX_CSV_ROWS) {
      throw new PayloadTooLargeException(
        `CSV exceeds ${MAX_CSV_ROWS}-row limit (got ${rows.length})`,
      );
    }

    const outcomes: ImportOutcome[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const email = row['email']?.trim().toLowerCase();
      const name = row['name']?.trim();
      const rawPerms = row['permissions']?.trim() ?? '';

      if (!email) {
        outcomes.push({ row: i + 1, email: email ?? '', outcome: 'error', error: 'Missing email' });
        continue;
      }

      const permKeys = rawPerms
        ? rawPerms.split(';').map((p) => p.trim()).filter(Boolean)
        : [];
      const invalidPerms = permKeys.filter((k) => !ALL_PERMISSION_KEYS.includes(k as PermissionKey));
      if (invalidPerms.length > 0) {
        outcomes.push({ row: i + 1, email, outcome: 'error', error: `Invalid permissions: ${invalidPerms.join(', ')}` });
        continue;
      }

      try {
        let user = await this.prisma.user.findUnique({ where: { email } });
        const existing = user
          ? await this.prisma.membership.findUnique({
              where: { userId_orgId: { userId: user.id, orgId } },
            })
          : null;

        if (existing?.status === 'active') {
          outcomes.push({ row: i + 1, email, outcome: 'already_member' });
          continue;
        }

        if (!user) {
          user = await this.prisma.user.create({
            data: { id: createId(), email, name: name ?? email.split('@')[0] },
          });
        }

        const membership = await this.prisma.membership.upsert({
          where: { userId_orgId: { userId: user.id, orgId } },
          update: { status: 'active' },
          create: { id: createId(), userId: user.id, orgId, status: 'active' },
        });

        if (permKeys.length > 0) {
          await this.assignPermissions(membership.id, permKeys as PermissionKey[]);
        }

        this.permissionsService.invalidate(user.id, orgId);

        if (sendInvites) {
          this.authService.requestMagicLink(email).catch(() => {});
          outcomes.push({ row: i + 1, email, outcome: 'invited' });
        } else {
          outcomes.push({ row: i + 1, email, outcome: 'created' });
        }
      } catch (err) {
        outcomes.push({ row: i + 1, email, outcome: 'error', error: (err as Error).message });
      }
    }

    return outcomes;
  }

  // ─── Update + remove ─────────────────────────────────────────────────────

  async updateMember(
    orgId: string,
    userId: string,
    data: UpdateMemberRequest,
    actorPerms: string[],
  ): Promise<MemberResponse> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
    });
    if (!membership) throw new NotFoundException('Membership not found');

    if (data.status !== undefined) {
      if (!actorPerms.includes('users:manage')) {
        throw new ForbiddenException('Requires users:manage');
      }
      await this.prisma.membership.update({
        where: { id: membership.id },
        data: { status: data.status },
      });
    }

    if (data.permissions !== undefined) {
      if (!actorPerms.includes('permissions:assign')) {
        throw new ForbiddenException('Requires permissions:assign');
      }
      await this.prisma.membershipPermission.deleteMany({ where: { membershipId: membership.id } });
      await this.assignPermissions(membership.id, data.permissions);
    }

    this.permissionsService.invalidate(userId, orgId);
    return this.getMemberResponse(membership.id);
  }

  async removeMember(orgId: string, userId: string): Promise<void> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
    });
    if (!membership) throw new NotFoundException('Membership not found');
    // MembershipPermission rows cascade via FK
    await this.prisma.membership.delete({ where: { id: membership.id } });
    this.permissionsService.invalidate(userId, orgId);
  }

  // ─── Permissions catalog ──────────────────────────────────────────────────

  async getPermissionsCatalog(): Promise<{ key: string; description: string }[]> {
    return this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async assignPermissions(membershipId: string, keys: PermissionKey[]): Promise<void> {
    const perms = await this.prisma.permission.findMany({ where: { key: { in: keys } } });
    await this.prisma.membershipPermission.createMany({
      data: perms.map((p) => ({ membershipId, permissionId: p.id })),
      skipDuplicates: true,
    });
  }

  private async getMemberResponse(membershipId: string): Promise<MemberResponse> {
    const m = await this.prisma.membership.findUniqueOrThrow({
      where: { id: membershipId },
      include: { user: true, permissions: { include: { permission: true } } },
    });
    return {
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      status: m.status,
      joinedAt: m.joinedAt,
      permissions: m.permissions.map((mp) => mp.permission.key as PermissionKey),
    };
  }
}
