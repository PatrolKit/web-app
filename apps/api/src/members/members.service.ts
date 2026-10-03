import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
import { MailService } from '../mail/mail.service';
import { ALL_PERMISSION_KEYS, type PermissionKey } from '../contracts/org.contracts';

const MAX_CSV_ROWS = 500;

/**
 * Who the Members page is for: patrollers, anyone given permissions, and anyone
 * invited here plainly. A ski swap seller has a membership too, because that's
 * where a seller profile hangs, but someone who is only a seller here isn't a
 * member and is managed under Ski Swap > Sellers.
 */
const IS_MEMBER: Prisma.MembershipWhereInput = {
  OR: [
    { sellerProfile: { is: null } },
    { sellerProfile: { is: { deletedAt: { not: null } } } },
    { patrollerProfile: { is: { deletedAt: null } } },
    { permissions: { some: {} } },
  ],
};

const SELLER_ONLY_MESSAGE =
  'This person is a ski swap seller here, not a member. Give them permissions, or add them to the patroller roster, to make them one.';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
    private readonly people: PersonService,
    private readonly touch: MembershipTouchService,
    private readonly mail: MailService,
  ) {}

  // ─── Invite email ─────────────────────────────────────────────────────────

  /**
   * Emails an existing member where and how to sign in: someone an
   * administrator added, who has never been told. Sent by hand, from the
   * Members page, as often as needed.
   */
  async sendInvite(orgId: string, userId: string): Promise<{ sentTo: string; status: string; inviteSentAt: Date | null }> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      include: { user: true, org: true },
    });
    if (!membership || membership.deletedAt || !(await this.isMember(membership.id))) {
      throw new NotFoundException('Member not found');
    }
    const email = membership.user.verifiedEmail ?? membership.user.email;
    if (!email) throw new BadRequestException('This member has no email address to send an invite to.');
    const { status, inviteSentAt } = await this.emailInvite(membership.id, email, membership.org.name);
    return { sentTo: email, status, inviteSentAt };
  }

  /**
   * Sends the invite and, if it went, records when on the membership. A
   * suppressed or failed send leaves the record as it was.
   */
  private async emailInvite(membershipId: string, email: string, orgName: string) {
    const { status } = await this.mail.sendMemberInvite(email, orgName);
    if (status !== 'sent') return { status, inviteSentAt: null };
    const inviteSentAt = new Date();
    await this.prisma.membership.update({ where: { id: membershipId }, data: { inviteSentAt } });
    return { status, inviteSentAt };
  }

  private async isMember(membershipId: string): Promise<boolean> {
    return (await this.prisma.membership.count({ where: { id: membershipId, ...IS_MEMBER } })) > 0;
  }

  // ─── List ─────────────────────────────────────────────────────────────────

  async listMembers(orgId: string): Promise<MemberResponse[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { orgId, deletedAt: null, ...IS_MEMBER },
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
        // A seller here becomes a member by being given something to do.
        if (await this.isMember(membership.id)) throw new BadRequestException('User is already a member of this org');
        if (data.permissions.length === 0) throw new BadRequestException(SELLER_ONLY_MESSAGE);
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

    // The invite email, not a sign-in link: a link expires long before some
    // people open it. Suppressed globally while OUTBOUND_NOTIFICATIONS is off.
    if (user.email) {
      const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } });
      // Awaited, so the response carries when it went: the Members page shows it.
      await this.emailInvite(membership.id, user.email, org.name).catch(() => {});
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
    const orgName = sendInvites
      ? (await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } })).name
      : null;

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
          if (await this.isMember(existingMembership.id)) {
            outcomes.push({ row: i + 1, email: email ?? '', outcome: 'already_member' });
            continue;
          }
          // Only a seller here: the row's permissions make them a member.
          if (permKeys.length === 0) {
            outcomes.push({ row: i + 1, email: email ?? '', outcome: 'error', error: SELLER_ONLY_MESSAGE });
            continue;
          }
        }

        const { user } = await this.people.resolveOrCreate({ email, phone, firstName, lastName });
        const membership = await this.people.upsertMembership(user.id, orgId);

        if (permKeys.length > 0) {
          await this.assignPermissions(membership.id, permKeys as PermissionKey[]);
        }

        this.permissionsService.invalidate(user.id, orgId);

        if (orgName && user.email) {
          this.emailInvite(membership.id, user.email, orgName).catch(() => {});
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
  inviteSentAt: Date | null;
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
    inviteSentAt: m.inviteSentAt,
    permissions: m.permissions.map((mp) => mp.permission.key as PermissionKey),
    roles: [
      ...(m.sellerProfile && !m.sellerProfile.deletedAt ? (['seller'] as const) : []),
      ...(m.patrollerProfile && !m.patrollerProfile.deletedAt ? (['patroller'] as const) : []),
    ],
  };
}
