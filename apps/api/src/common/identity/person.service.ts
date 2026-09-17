import { BadRequestException, Injectable } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { isUniqueViolation } from '../util/prisma-errors';
import type { Prisma, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipTouchService } from './membership-touch.service';
import { normalizeEmail, normalizeNamePart, normalizeNspId, normalizePhone } from '../util/person';

export interface PersonIdentifiers {
  email?: string | null;
  phone?: string | null;
  nspId?: string | null;
}

export interface PersonDetails extends PersonIdentifiers {
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * The one implementation of "who is this person, and do we already know them".
 *
 * Matching order is NSP ID, then email, then phone. NSP ID leads because it is
 * an issued identifier rather than a contact channel: it neither changes nor
 * gets shared, so it is the strongest signal available. Verification status is
 * irrelevant to matching — a roster CSV of unverified emails would be useless
 * otherwise. Unverified contacts simply grant nothing until proven.
 */
@Injectable()
export class PersonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly touch: MembershipTouchService,
  ) {}

  /** Normalises identifiers, dropping anything that cannot be a valid value. */
  normalize(input: PersonIdentifiers): PersonIdentifiers {
    return {
      email: normalizeEmail(input.email),
      phone: normalizePhone(input.phone),
      nspId: normalizeNspId(input.nspId),
    };
  }

  /** Finds an existing person by any identifier, or null. */
  async resolve(input: PersonIdentifiers): Promise<User | null> {
    const { email, phone, nspId } = this.normalize(input);

    if (nspId) {
      const byNsp = await this.prisma.user.findUnique({ where: { nspId } });
      if (byNsp) return byNsp;
    }
    if (email) {
      const byEmail = await this.prisma.user.findFirst({ where: { email } });
      if (byEmail) return byEmail;
    }
    if (phone) {
      const byPhone = await this.prisma.user.findFirst({ where: { phone } });
      if (byPhone) return byPhone;
    }
    return null;
  }

  /**
   * Finds or creates a person. On a match, fills in identifiers and name parts
   * the existing row is missing but never overwrites what is already there —
   * an import must not clobber data the person supplied themselves.
   *
   * A claim that collides with someone else's *verified* contact is rejected:
   * the caller is expected to disambiguate with a human.
   */
  async resolveOrCreate(input: PersonDetails): Promise<{ user: User; created: boolean }> {
    const { email, phone, nspId } = this.normalize(input);
    const firstName = normalizeNamePart(input.firstName);
    const lastName = normalizeNamePart(input.lastName);

    const existing = await this.resolve({ email, phone, nspId });

    if (existing) {
      await this.assertClaimable({ email, phone }, existing.id);
      const fill: Prisma.UserUpdateInput = {
        ...(email && !existing.email ? { email } : {}),
        ...(phone && !existing.phone ? { phone } : {}),
        ...(nspId && !existing.nspId ? { nspId } : {}),
        ...(firstName && !existing.firstName ? { firstName } : {}),
        ...(lastName && !existing.lastName ? { lastName } : {}),
      };
      if (Object.keys(fill).length === 0) return { user: existing, created: false };

      const user = await this.prisma.user.update({ where: { id: existing.id }, data: fill });
      await this.touch.touchAllForUser(user.id);
      return { user, created: false };
    }

    await this.assertClaimable({ email, phone }, null);
    const user = await this.prisma.user.create({
      data: { id: createId(), email, phone, nspId, firstName, lastName },
    });
    return { user, created: true };
  }

  /**
   * Grants a membership, resurrecting a soft-removed one rather than creating a
   * duplicate. `@@unique([userId, orgId])` means there is only ever one row.
   */
  async upsertMembership(userId: string, orgId: string): Promise<{ id: string }> {
    try {
      return await this.prisma.membership.upsert({
        where: { userId_orgId: { userId, orgId } },
        update: { deletedAt: null, updatedAt: new Date() },
        create: { id: createId(), userId, orgId, updatedAt: new Date() },
        select: { id: true },
      });
    } catch (err) {
      // Same race as `claimSellerProfile`, one call earlier: two joins arriving
      // together both find no membership and both insert one.
      if (!isUniqueViolation(err)) throw err;
      return this.prisma.membership.update({
        where: { userId_orgId: { userId, orgId } },
        data: { deletedAt: null, updatedAt: new Date() },
        select: { id: true },
      });
    }
  }

  /**
   * An unverified claim may collide with another unverified claim, but never
   * with a contact someone else has already proved they control.
   */
  private async assertClaimable(
    contacts: { email?: string | null; phone?: string | null },
    selfUserId: string | null,
  ): Promise<void> {
    if (contacts.email) {
      const holder = await this.prisma.user.findUnique({
        where: { verifiedEmail: contacts.email },
        select: { id: true },
      });
      if (holder && holder.id !== selfUserId) {
        throw new BadRequestException(
          `That email is already verified by another account (${contacts.email}).`,
        );
      }
    }
    if (contacts.phone) {
      const holder = await this.prisma.user.findUnique({
        where: { verifiedPhone: contacts.phone },
        select: { id: true },
      });
      if (holder && holder.id !== selfUserId) {
        throw new BadRequestException(
          `That phone number is already verified by another account (${contacts.phone}).`,
        );
      }
    }
  }
}
