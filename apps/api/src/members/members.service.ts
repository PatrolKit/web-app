import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { PermissionsService } from '../permissions/permissions.service';
import { PersonService } from '../common/identity/person.service';
import { MembershipTouchService } from '../common/identity/membership-touch.service';
import { displayName } from '../common/util/person';
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
    private readonly people: PersonService,
    private readonly touch: MembershipTouchService,
  ) {}

  // ─── List ─────────────────────────────────────────────────────────────────

  async listMembers(orgId: string): Promise<MemberResponse[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { orgId, deletedAt: null },
      include: {
        user: true,
        permissions: { include: { permission: true } },
        sellerProfile: true,
        patrollerProfile: true,
      },
      orderBy: { joinedAt: 'asc' },
    });

    return memberships.map(toMemberResponse);
  }

  // ─── Single invite ────────────────────────────────────────────────────────

  async inviteMember(
    orgId: string,
    inviterUserId: string,
    data: InviteMemberRequest,
  ): Promise<MemberResponse> {
    void inviterUserId;

    const existingUser = await this.people.resolve({ email: data.email, phone: data.phone });
    if (existingUser) {
      const membership = await this.prisma.membership.findUnique({
        where: { userId_orgId: { userId: existingUser.id, orgId } },
      });
      if (membership && membership.deletedAt === null) {
        throw new BadRequestException('User is already a member of this org');
      }
    }

    const { user } = await this.people.resolveOrCreate({
      email: data.email,
      phone: data.phone,
      firstName: data.firstName,
      lastName: data.lastName,
    });
    const membership = await this.people.upsertMembership(user.id, orgId);

    if (data.permissions.length > 0) {
      await this.assignPermissions(membership.id, data.permissions as PermissionKey[]);
    }

    this.permissionsService.invalidate(user.id, orgId);

    // Onboarding is suppressed globally while OUTBOUND_NOTIFICATIONS is off.
    if (user.email) {
      this.authService.requestLogin({ email: user.email }).catch(() => {});
    }

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
      const phone = row['phone']?.trim();
      const firstName = row['firstName']?.trim() ?? row['first_name']?.trim();
      const lastName = row['lastName']?.trim() ?? row['last_name']?.trim();
      const rawPerms = row['permissions']?.trim() ?? '';

      if (!email && !phone) {
        outcomes.push({
          row: i + 1,
          email: email ?? '',
          outcome: 'error',
          error: 'Row needs an email or a phone number',
        });
        continue;
      }

      const permKeys = rawPerms
        ? rawPerms.split(';').map((p) => p.trim()).filter(Boolean)
        : [];
      const invalidPerms = permKeys.filter((k) => !ALL_PERMISSION_KEYS.includes(k as PermissionKey));
      if (invalidPerms.length > 0) {
        outcomes.push({ row: i + 1, email: email ?? '', outcome: 'error', error: `Invalid permissions: ${invalidPerms.join(', ')}` });
        continue;
      }

      try {
        const existing = await this.people.resolve({ email, phone });
        const existingMembership = existing
          ? await this.prisma.membership.findUnique({
              where: { userId_orgId: { userId: existing.id, orgId } },
            })
          : null;

        if (existingMembership && existingMembership.deletedAt === null) {
          outcomes.push({ row: i + 1, email: email ?? '', outcome: 'already_member' });
          continue;
        }

        const { user } = await this.people.resolveOrCreate({ email, phone, firstName, lastName });
        const membership = await this.people.upsertMembership(user.id, orgId);

        if (permKeys.length > 0) {
          await this.assignPermissions(membership.id, permKeys as PermissionKey[]);
        }

        this.permissionsService.invalidate(user.id, orgId);

        if (sendInvites && user.email) {
          this.authService.requestLogin({ email: user.email }).catch(() => {});
          outcomes.push({ row: i + 1, email: email ?? '', outcome: 'invited' });
        } else {
          outcomes.push({ row: i + 1, email: email ?? '', outcome: 'created' });
        }
      } catch (err) {
        outcomes.push({ row: i + 1, email: email ?? '', outcome: 'error', error: (err as Error).message });
      }
    }

    return outcomes;
  }

  // ─── Update + remove ─────────────────────────────────────────────────────

  async updateMember(
    orgId: string,
    userId: string,
    data: UpdateMemberRequest,
    actorUserId: string,
  ): Promise<MemberResponse> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
    });
    if (!membership) throw new NotFoundException('Membership not found');

    const actorPerms = await this.permissionsService.getPermissions(actorUserId, orgId);

    if (data.removed !== undefined) {
      if (!actorPerms.includes('users:manage')) {
        throw new ForbiddenException('Requires users:manage');
      }
      await this.prisma.membership.update({
        where: { id: membership.id },
        data: { deletedAt: data.removed ? new Date() : null, updatedAt: new Date() },
      });
    }

    if (data.permissions !== undefined) {
      if (!actorPerms.includes('permissions:assign')) {
        throw new ForbiddenException('Requires permissions:assign');
      }
      await this.prisma.membershipPermission.deleteMany({ where: { membershipId: membership.id } });
      await this.assignPermissions(membership.id, data.permissions);
      await this.touch.touch(membership.id);
    }

    this.permissionsService.invalidate(userId, orgId);
    return this.getMemberResponse(membership.id);
  }

  /**
   * Soft removal. The row survives so that offline devices syncing on
   * `updatedSince` receive a tombstone rather than silently losing the person.
   */
  async removeMember(orgId: string, userId: string): Promise<void> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
    });
    if (!membership) throw new NotFoundException('Membership not found');

    await this.prisma.membership.update({
      where: { id: membership.id },
      data: { deletedAt: new Date(), updatedAt: new Date() },
    });
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
      include: {
        user: true,
        permissions: { include: { permission: true } },
        sellerProfile: true,
        patrollerProfile: true,
      },
    });
    return toMemberResponse(m);
  }
}

type MembershipWithRelations = {
  id: string;
  userId: string;
  joinedAt: Date;
  deletedAt: Date | null;
  user: {
    email: string | null;
    emailVerifiedAt: Date | null;
    phone: string | null;
    phoneVerifiedAt: Date | null;
    firstName: string | null;
    lastName: string | null;
  };
  permissions: { permission: { key: string } }[];
  sellerProfile: { deletedAt: Date | null } | null;
  patrollerProfile: { deletedAt: Date | null } | null;
};

export function toMemberResponse(m: MembershipWithRelations): MemberResponse {
  return {
    userId: m.userId,
    membershipId: m.id,
    email: m.user.email,
    emailVerified: m.user.emailVerifiedAt !== null,
    phone: m.user.phone,
    phoneVerified: m.user.phoneVerifiedAt !== null,
    firstName: m.user.firstName,
    lastName: m.user.lastName,
    displayName: displayName(m.user),
    joinedAt: m.joinedAt,
    removedAt: m.deletedAt,
    permissions: m.permissions.map((mp) => mp.permission.key as PermissionKey),
    roles: [
      ...(m.sellerProfile && !m.sellerProfile.deletedAt ? (['seller'] as const) : []),
      ...(m.patrollerProfile && !m.patrollerProfile.deletedAt ? (['patroller'] as const) : []),
    ],
  };
}
