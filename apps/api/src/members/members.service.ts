import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IS_MEMBER } from '../common/identity/membership-kinds';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import { PersonService } from '../common/identity/person.service';
import { MembershipTouchService } from '../common/identity/membership-touch.service';
import { displayName, normalizeNamePart, normalizeNspId, normalizePhone } from '../common/util/person';
import { unverifyChangedContacts } from '../common/identity/contact-verification';
import { clearPinsMatching } from '../common/identity/clock-code';
import { ClockOutService } from '../time-clock/clock-out.service';
import { parse } from 'csv-parse/sync';
import type {
  MemberResponse,
  InviteMemberRequest,
  UpdateMemberRequest,
  ImportOutcome,
  ImportMembersRequest,
} from '../contracts/members.contracts';
import { MailService } from '../mail/mail.service';
import { ALL_PERMISSION_KEYS, type PermissionKey } from '../contracts/org.contracts';

/** What a members manager may change about a person (Plan 57 D6). */
const PERSON_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'nspId', 'patrolLevel', 'inactive', 'clearClockPin'] as const;

const MEMBER_INCLUDE = {
  user: true,
  permissions: { include: { permission: true } },
  sellerProfile: true,
  patrollerProfile: true,
} as const;

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
    private readonly people: PersonService,
    private readonly touch: MembershipTouchService,
    private readonly mail: MailService,
    private readonly entries: ClockOutService,
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
      include: MEMBER_INCLUDE,
      orderBy: { joinedAt: 'asc' },
    });
    // Who is on entry now, so taking someone off the clock can warn first.
    const openEntries = await this.prisma.timeEntry.findMany({
      where: { orgId, status: 'open', deletedAt: null },
      select: { clockInAt: true, resort: { select: { name: true } }, patroller: { select: { membershipId: true } } },
    });
    const clockedIn = new Map(openEntries.map((s) => [s.patroller.membershipId, { resortName: s.resort.name, since: s.clockInAt }]));

    // Activity from sessions: a sign-in or a renewal writes a refresh token,
    // and a renewal happens only when someone is using the app, so the newest
    // one is when they were last active. Any still open (not revoked, not
    // expired) means they're signed in somewhere.
    const userIds = memberships.map((m) => m.userId);
    const [last, open] = userIds.length
      ? await Promise.all([
          this.prisma.refreshToken.groupBy({ by: ['userId'], where: { userId: { in: userIds } }, _max: { createdAt: true } }),
          this.prisma.refreshToken.groupBy({
            by: ['userId'],
            where: { userId: { in: userIds }, revokedAt: null, expiresAt: { gt: new Date() } },
            _count: { _all: true },
          }),
        ])
      : [[], []];
    const lastBy = new Map(last.map((r) => [r.userId, r._max.createdAt]));
    const openBy = new Set(open.map((r) => r.userId));

    return memberships.map((m) => ({
      ...toMemberResponse(m),
      clockedIn: clockedIn.get(m.id) ?? null,
      lastActiveAt: lastBy.get(m.userId) ?? null,
      signedIn: openBy.has(m.userId),
    }));
  }

  // ─── Single invite ────────────────────────────────────────────────────────

  /**
   * Adds a member (Plan 57 D4): by email, phone or NSP ID, contact optional.
   * Someone who is only a seller here becomes a member by being added; the
   * invite email goes only when there is an address to send it to.
   */
  async inviteMember(
    orgId: string,
    inviterUserId: string,
    data: InviteMemberRequest,
  ): Promise<MemberResponse> {
    const nspId = normalizeNspId(data.nspId);
    const existingUser = await this.people.resolve({ email: data.email, phone: data.phone, nspId });
    if (existingUser) {
      const membership = await this.prisma.membership.findUnique({
        where: { userId_orgId: { userId: existingUser.id, orgId } },
      });
      if (membership && membership.deletedAt === null && (await this.isMember(membership.id))) {
        throw new BadRequestException('User is already a member of this org');
      }
      if (nspId && existingUser.nspId && existingUser.nspId !== nspId) {
        throw new ConflictException(`That person already has NSP ID ${existingUser.nspId}`);
      }
    }

    const { user } = await this.people.resolveOrCreate({
      email: data.email,
      phone: data.phone,
      nspId,
      firstName: data.firstName,
      lastName: data.lastName,
    });
    if (data.patrolLevel?.trim()) {
      await this.prisma.user.update({ where: { id: user.id }, data: { patrolLevel: data.patrolLevel.trim() } });
    }
    const membership = await this.people.upsertMembership(user.id, orgId);
    await this.people.ensureMemberRecord(membership.id);
    if (nspId) await clearPinsMatching(this.prisma, await this.memberOrgIds(user.id), nspId);

    if (data.permissions.length > 0) {
      await this.assignPermissions(membership.id, data.permissions as PermissionKey[]);
    }
    await this.touch.touchAllForUser(user.id);
    this.permissionsService.invalidate(user.id, orgId);
    await this.audit(orgId, inviterUserId, 'member.added', user.id, { after: personFields(await this.getMemberResponse(membership.id)) });

    // The invite email, not a sign-in link: a link expires long before some
    // people open it. Suppressed globally while OUTBOUND_NOTIFICATIONS is off.
    if (user.email) {
      const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } });
      // Awaited, so the response carries when it went: the Members page shows it.
      await this.emailInvite(membership.id, user.email, org.name).catch(() => {});
    }

    return this.getMemberResponse(membership.id);
  }

  // ─── Bulk import (Plan 57 D10) ────────────────────────────────────────────

  /**
   * Reads a CSV and guesses which column is which, so whatever the patrol's NSP
   * export calls them will do. Nothing is written: the mapped rows come back to
   * `importRows` once someone has checked them.
   */
  parseImportFile(buffer: Buffer): {
    headers: string[];
    mapping: Record<string, string | null>;
    rows: Record<string, string>[];
  } {
    let records: Record<string, string>[];
    try {
      records = parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];
    } catch {
      throw new BadRequestException('That file is not a CSV this can read.');
    }
    const headers = records.length ? Object.keys(records[0] ?? {}) : [];
    const find = (...candidates: string[]): string | null =>
      headers.find((h) => candidates.includes(h.toLowerCase().replace(/[^a-z]/g, ''))) ?? null;

    return {
      headers,
      mapping: {
        firstName: find('firstname', 'first', 'givenname'),
        lastName: find('lastname', 'last', 'surname', 'familyname'),
        email: find('email', 'emailaddress'),
        phone: find('phone', 'phonenumber', 'mobile', 'cell'),
        nspId: find('nspid', 'nsp', 'memberid', 'nspnumber', 'id'),
        patrolLevel: find('patrollevel', 'level', 'certification', 'cert'),
        inactive: find('inactive'),
        permissions: find('permissions'),
      },
      rows: records,
    };
  }

  /**
   * Each row is a person, matched by NSP ID, then email, then phone. A new one
   * is added; one already a member is left alone (`preserve`) or brought up to
   * date with the file (`overwrite`). Someone who is only a seller here becomes
   * a member. Nobody is emailed unless `sendInvites`.
   */
  async importRows(orgId: string, actorId: string, req: ImportMembersRequest): Promise<ImportOutcome[]> {
    const outcomes: ImportOutcome[] = [];
    const orgName = req.sendInvites
      ? (await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } })).name
      : null;
    let created = 0;
    let updated = 0;

    for (const [index, row] of req.rows.entries()) {
      const email = row.email?.trim().toLowerCase() || undefined;
      const phone = row.phone?.trim() || undefined;
      const nspId = normalizeNspId(row.nspId) ?? undefined;
      const firstName = normalizeNamePart(row.firstName) ?? undefined;
      const lastName = normalizeNamePart(row.lastName) ?? undefined;
      const patrolLevel = row.patrolLevel?.trim() || undefined;
      const inactive = row.inactive ? /^(1|true|yes|y|x|inactive)$/i.test(row.inactive.trim()) : undefined;
      const name = [firstName, lastName].filter(Boolean).join(' ') || email || phone || nspId || '';
      const out = (o: Omit<ImportOutcome, 'row' | 'name' | 'email'>) =>
        outcomes.push({ row: index + 1, name, email: email ?? '', ...o });

      if (!email && !phone && !nspId) { out({ outcome: 'error', error: 'Needs an email, a phone number or an NSP ID' }); continue; }
      if (!email && !(firstName && lastName)) { out({ outcome: 'error', error: 'Without an email, needs a first and last name' }); continue; }
      const permKeys = (row.permissions ?? '').split(';').map((p) => p.trim()).filter(Boolean);
      const invalid = permKeys.filter((k) => !ALL_PERMISSION_KEYS.includes(k as PermissionKey));
      if (invalid.length) { out({ outcome: 'error', error: `Invalid permissions: ${invalid.join(', ')}` }); continue; }

      try {
        const existing = await this.people.resolve({ email, phone, nspId });
        if (existing && nspId && existing.nspId && existing.nspId !== nspId) {
          out({ outcome: 'error', error: `Matches someone whose NSP ID is ${existing.nspId}` });
          continue;
        }
        const existingMembership = existing
          ? await this.prisma.membership.findUnique({ where: { userId_orgId: { userId: existing.id, orgId } } })
          : null;
        const wasMember = !!existingMembership && existingMembership.deletedAt === null && (await this.isMember(existingMembership.id));
        if (wasMember && req.strategy === 'preserve') { out({ outcome: 'already_member' }); continue; }

        const { user } = await this.people.resolveOrCreate({ email, phone, nspId, firstName, lastName });
        if (wasMember) {
          await this.prisma.user.update({
            where: { id: user.id },
            data: {
              ...(firstName ? { firstName } : {}),
              ...(lastName ? { lastName } : {}),
              ...(patrolLevel ? { patrolLevel } : {}),
            },
          });
        } else if (patrolLevel && !user.patrolLevel) {
          await this.prisma.user.update({ where: { id: user.id }, data: { patrolLevel } });
        }
        const membership = await this.people.upsertMembership(user.id, orgId);
        await this.people.ensureMemberRecord(membership.id);
        if (nspId) await clearPinsMatching(this.prisma, await this.memberOrgIds(user.id), nspId);
        if (inactive !== undefined) {
          await this.prisma.patrollerProfile.update({ where: { membershipId: membership.id }, data: { active: !inactive } });
          if (inactive) await this.entries.closeFor(orgId, membership.id, actorId);
        }
        if (permKeys.length) await this.assignPermissions(membership.id, permKeys as PermissionKey[]);
        await this.touch.touchAllForUser(user.id);
        this.permissionsService.invalidate(user.id, orgId);

        if (wasMember) { updated++; out({ outcome: 'updated' }); continue; }
        created++;
        if (orgName && user.email) {
          await this.emailInvite(membership.id, user.email, orgName).catch(() => {});
          out({ outcome: 'invited' });
        } else {
          out({ outcome: 'created' });
        }
      } catch (err) {
        out({ outcome: 'error', error: (err as Error).message });
      }
    }

    // One row with the counts, not one per person: an import is one decision.
    await this.audit(orgId, actorId, 'member.imported', null, {
      strategy: req.strategy, rows: req.rows.length, created, updated,
      errors: outcomes.filter((o) => o.outcome === 'error').length,
    });
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
      include: { user: true },
    });
    if (!membership) throw new NotFoundException('Membership not found');

    const actorPerms = await this.permissionsService.getPermissions(actorUserId, orgId);
    const touchesPerson = PERSON_FIELDS.some((f) => data[f] !== undefined);
    if ((data.removed !== undefined || touchesPerson) && !actorPerms.includes('users:manage')) {
      throw new ForbiddenException('Requires users:manage');
    }
    if (data.permissions !== undefined && !actorPerms.includes('permissions:assign')) {
      throw new ForbiddenException('Requires permissions:assign');
    }
    const before = personFields(await this.getMemberResponse(membership.id));

    if (touchesPerson) await this.updatePerson(orgId, membership, data, actorUserId);

    if (data.removed !== undefined) {
      if (data.removed) await this.entries.closeFor(orgId, membership.id, actorUserId);
      await this.prisma.membership.update({
        where: { id: membership.id },
        data: { deletedAt: data.removed ? new Date() : null, updatedAt: new Date() },
      });
      if (!data.removed) await this.people.ensureMemberRecord(membership.id);
    }

    if (data.permissions !== undefined) {
      await this.prisma.membershipPermission.deleteMany({ where: { membershipId: membership.id } });
      await this.assignPermissions(membership.id, data.permissions);
      // Being given something to do here makes a member of a seller (D2).
      if (data.permissions.length) await this.people.ensureMemberRecord(membership.id);
      await this.touch.touch(membership.id);
    }

    this.permissionsService.invalidate(userId, orgId);
    const after = await this.getMemberResponse(membership.id);
    await this.audit(orgId, actorUserId, data.removed ? 'member.removed' : 'member.updated', userId, {
      before, after: personFields(after),
    });
    return after;
  }

  /**
   * The person's details, their member record and their PIN (Plan 57 D3–D8).
   * Contact changes keep today's rules: changing a proven address unverifies it.
   */
  private async updatePerson(
    orgId: string,
    membership: { id: string; userId: string; user: Prisma.UserGetPayload<object> },
    data: UpdateMemberRequest,
    actorId: string,
  ): Promise<void> {
    const u = membership.user;
    const nspId = data.nspId === undefined ? undefined : normalizeNspId(data.nspId);
    if (nspId && nspId !== u.nspId) {
      const holder = await this.prisma.user.findUnique({ where: { nspId } });
      if (holder && holder.id !== u.id) throw new ConflictException(`NSP ID ${nspId} already belongs to ${displayName(holder)}`);
    }
    const phone = data.phone === undefined ? undefined : normalizePhone(data.phone);
    if (data.email !== undefined || phone !== undefined || nspId !== undefined) {
      const next = {
        email: data.email === undefined ? u.email : data.email,
        phone: phone === undefined ? u.phone : phone,
        nspId: nspId === undefined ? u.nspId : nspId,
      };
      // Contact is optional, but a member has to be someone (D4).
      if (!next.email && !next.phone && !next.nspId) {
        throw new BadRequestException('A member needs an email, a phone number or an NSP ID.');
      }
    }

    await this.prisma.user.update({
      where: { id: u.id },
      data: {
        ...unverifyChangedContacts(u, { email: data.email, phone }),
        ...(data.firstName !== undefined ? { firstName: normalizeNamePart(data.firstName) } : {}),
        ...(data.lastName !== undefined ? { lastName: normalizeNamePart(data.lastName) } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(nspId !== undefined ? { nspId } : {}),
        ...(data.patrolLevel !== undefined ? { patrolLevel: data.patrolLevel?.trim() || null } : {}),
      },
    });

    await this.people.ensureMemberRecord(membership.id);
    await this.prisma.patrollerProfile.update({
      where: { membershipId: membership.id },
      data: {
        ...(data.inactive !== undefined ? { active: !data.inactive } : {}),
        // An NSP ID retires the PIN (D7); so does a manager clearing it (D9).
        ...(nspId || data.clearClockPin ? { clockPin: null } : {}),
      },
    });
    if (nspId) await clearPinsMatching(this.prisma, await this.memberOrgIds(u.id), nspId);
    if (data.inactive === true) await this.entries.closeFor(orgId, membership.id, actorId);

    // Name, NSP ID and patrol level live on User, so every membership moves.
    await this.touch.touchAllForUser(u.id);
  }

  /**
   * Soft removal. The row survives so that offline devices syncing on
   * `updatedSince` receive a tombstone rather than silently losing the person.
   */
  async removeMember(orgId: string, userId: string, actorId?: string): Promise<void> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
    });
    if (!membership) throw new NotFoundException('Membership not found');
    // No open entry outlives its member (D5).
    await this.entries.closeFor(orgId, membership.id, actorId);
    await this.audit(orgId, actorId, 'member.removed', userId, {});

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

  /** The orgs where this person is a member: where their NSP ID is a clock code. */
  private async memberOrgIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.membership.findMany({ where: { userId, deletedAt: null }, select: { orgId: true } });
    return rows.map((r) => r.orgId);
  }

  /** Every change to a member is audited with what it replaced (Plan 55 D11). */
  private async audit(
    orgId: string,
    actorId: string | undefined,
    action: string,
    userId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorType: 'user',
        actorId: actorId ?? null,
        orgId,
        action,
        targetType: userId ? 'user' : null,
        targetId: userId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

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
      include: MEMBER_INCLUDE,
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
    nspId: string | null;
    patrolLevel: string | null;
  };
  permissions: { permission: { key: string } }[];
  sellerProfile: { deletedAt: Date | null } | null;
  patrollerProfile: { deletedAt: Date | null; active: boolean; clockPin: string | null } | null;
};

/** What an audit row keeps of a member: never a PIN, only whether there is one. */
function personFields(m: MemberResponse) {
  return {
    firstName: m.firstName, lastName: m.lastName, email: m.email, phone: m.phone,
    nspId: m.nspId, patrolLevel: m.patrolLevel, inactive: m.inactive, clockPinSet: m.clockPinSet,
    permissions: m.permissions, removed: m.removedAt !== null,
  };
}

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
    nspId: m.user.nspId,
    patrolLevel: m.user.patrolLevel,
    inactive: m.patrollerProfile ? !m.patrollerProfile.active : false,
    clockPinSet: !!m.patrollerProfile?.clockPin && !m.user.nspId,
    canClockIn:
      m.deletedAt === null && !!m.patrollerProfile && !m.patrollerProfile.deletedAt && m.patrollerProfile.active &&
      (!!m.user.nspId || !!m.patrollerProfile.clockPin),
  };
}
