import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PersonService } from '../common/identity/person.service';
import { MailService } from '../mail/mail.service';
import { createId } from '@paralleldrive/cuid2';
import type {
  CreateOrgRequest,
  CreateOrgResponse,
  PlatformOrgResponse,
  PlatformPatchOrgRequest,
  PlatformUserPage,
  PlatformUserQuery,
} from '../contracts/members.contracts';
import { ALL_PERMISSION_KEYS } from '../contracts/org.contracts';

@Injectable()
export class PlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly people: PersonService,
    private readonly mail: MailService,
  ) {}

  async listOrgs(): Promise<PlatformOrgResponse[]> {
    const orgs = await this.prisma.organization.findMany({ orderBy: { createdAt: 'desc' } });
    return orgs.map((o) => ({
      id: o.id, name: o.name, slug: o.slug, status: o.status, createdAt: o.createdAt,
    }));
  }

  /**
   * A new organization and its first owner, with every permission.
   *
   * The owner is invited the way any member is (`MembersService.inviteMember`):
   * found by their email, or, as is usual for a new patrol, given an account,
   * and emailed to say they've been added. They sign in with a code sent to
   * that address, which proves it's theirs.
   */
  async createOrg(data: CreateOrgRequest): Promise<CreateOrgResponse> {
    const existing = await this.prisma.organization.findUnique({ where: { slug: data.slug } });
    if (existing) throw new ConflictException('Slug already in use');

    // Before the org exists: an email that's someone else's verified address
    // is refused here, with nothing left half-made.
    const { user: owner, created } = await this.people.resolveOrCreate({ email: data.ownerEmail });

    const org = await this.prisma.organization.create({
      data: { id: createId(), name: data.name, slug: data.slug },
    });

    // Seed owner membership with all permissions
    const membership = await this.people.upsertMembership(owner.id, org.id);
    const allPerms = await this.prisma.permission.findMany({
      where: { key: { in: ALL_PERMISSION_KEYS } },
    });
    await this.prisma.membershipPermission.createMany({
      data: allPerms.map((p) => ({ membershipId: membership.id, permissionId: p.id })),
    });

    // Seed user_management core module (enabled)
    await this.prisma.orgModule.create({
      data: {
        id: createId(), orgId: org.id, moduleKey: 'user_management',
        enabled: true, enabledAt: new Date(), enabledBy: owner.id,
      },
    });

    // The invite email, as Members sends it. Suppressed while outbound mail
    // is off; a failure to send never undoes the org.
    const email = owner.email ?? data.ownerEmail;
    const sent = await this.mail.sendMemberInvite(email, org.name).catch(() => ({ status: 'failed' as const }));
    if (sent.status === 'sent') {
      await this.prisma.membership.update({ where: { id: membership.id }, data: { inviteSentAt: new Date() } });
    }

    return {
      id: org.id, name: org.name, slug: org.slug, status: org.status, createdAt: org.createdAt,
      owner: { email, created, invite: sent.status === 'sent' ? 'sent' : 'not_sent' },
    };
  }

  async getOrg(id: string): Promise<PlatformOrgResponse> {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException('Organization not found');
    return { id: org.id, name: org.name, slug: org.slug, status: org.status, createdAt: org.createdAt };
  }

  async patchOrg(id: string, data: PlatformPatchOrgRequest): Promise<PlatformOrgResponse> {
    const org = await this.prisma.organization.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.status !== undefined && { status: data.status }),
      },
    });
    return { id: org.id, name: org.name, slug: org.slug, status: org.status, createdAt: org.createdAt };
  }

  async deleteOrg(id: string): Promise<void> {
    await this.prisma.organization.delete({ where: { id } });
  }

  // ─── Users ───────────────────────────────────────────────────────────────────

  /**
   * Every user on the platform, filtered and paged.
   *
   * Paged because this grows with attendance rather than with staff: every
   * seller who checks in becomes a user, so a venue's second season already
   * outnumbers anything that would render comfortably at once.
   */
  async listUsers(query: PlatformUserQuery): Promise<PlatformUserPage> {
    const { q, orgId, membership, page, limit } = query;

    const where: Prisma.UserWhereInput = {};

    if (q) {
      // One box for a person, matched against everything they are known by.
      // A phone is normalised to E.164, so a search for "555 0101" finds
      // nothing — matching the raw digits is what people actually type.
      const digits = q.replace(/\D/g, '');
      where.OR = [
        { firstName: { contains: q } },
        { lastName: { contains: q } },
        { email: { contains: q } },
        ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
      ];
    }

    // "In this org" and "in no org" both mean live memberships. A removed one
    // does not grant access, so counting it here would list people who cannot
    // actually get in.
    if (orgId) {
      where.memberships = { some: { orgId, deletedAt: null } };
    } else if (membership === 'none') {
      where.memberships = { none: { deletedAt: null } };
    } else if (membership === 'any') {
      where.memberships = { some: { deletedAt: null } };
    }

    const [total, users] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          // Removed ones travel too: the page distinguishes "never belonged
          // anywhere" from "was taken off Demo Org", which is most of what you
          // want to know when someone cannot sign in.
          memberships: { include: { org: { select: { id: true, name: true } } } },
        },
      }),
    ]);

    return {
      total,
      page,
      limit,
      users: users.map((u) => ({
        id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        emailVerified: !!u.emailVerifiedAt,
        phone: u.phone,
        phoneVerified: !!u.phoneVerifiedAt,
        isSuperAdmin: u.isSuperAdmin,
        createdAt: u.createdAt,
        memberships: u.memberships.map((m) => ({
          id: m.id,
          orgId: m.orgId,
          orgName: m.org.name,
          removed: !!m.deletedAt,
        })),
      })),
    };
  }

  /**
   * Puts a user into an org with no permissions.
   *
   * Deliberately none: this exists to un-strand someone, and what they should
   * be able to do is that org's decision, made on its own Members page where
   * the roles are. Reviving a removed membership rather than creating a second
   * one — the pair is unique per org, and a duplicate would fork their history.
   */
  async addMembership(userId: string, orgId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organization not found');

    const existing = await this.prisma.membership.findFirst({ where: { userId, orgId } });
    if (existing) {
      if (!existing.deletedAt) throw new ConflictException('Already a member of that organization');
      await this.prisma.membership.update({
        where: { id: existing.id },
        data: { deletedAt: null, updatedAt: new Date() },
      });
      return;
    }

    await this.prisma.membership.create({ data: { userId, orgId } });
  }

  /**
   * Takes a user off an org. Soft, like every other removal: offline devices
   * need the tombstone to learn that someone left the roster.
   */
  async removeMembership(userId: string, membershipId: string): Promise<void> {
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, userId },
    });
    if (!membership) throw new NotFoundException('Membership not found');
    if (membership.deletedAt) return;

    await this.prisma.membership.update({
      where: { id: membership.id },
      data: { deletedAt: new Date(), updatedAt: new Date() },
    });
  }

  /**
   * Removes the person entirely. Cascades to their memberships, seller profiles
   * and anything hanging off those, so the caller is asked to confirm against
   * what they will lose rather than a count they cannot see.
   */
  async deleteUser(userId: string, actorId: string): Promise<void> {
    if (userId === actorId) {
      throw new ConflictException('You cannot delete your own account from here');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    await this.prisma.user.delete({ where: { id: userId } });
  }
}
