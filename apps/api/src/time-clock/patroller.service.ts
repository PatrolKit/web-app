import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TimeClockFoldService } from './fold.service';
import { PersonService } from '../common/identity/person.service';
import { MembershipTouchService } from '../common/identity/membership-touch.service';
import { ContactChallengeService, isTooManyCodes } from '../auth/contact-challenge.service';
import { displayName, normalizeNamePart, normalizeNspId, normalizePhone } from '../common/util/person';
import { createId } from '@paralleldrive/cuid2';
import { parse as parseCsv } from 'csv-parse/sync';
import { SmsService } from '../sms/sms.service';
import type { PatrollerResponse } from '../contracts/time-clock.contracts';
import { unverifyChangedContacts } from '../common/identity/contact-verification';

export { normalizeNspId };

/**
 * A roster row is assembled from three tables: the person (`User`), their
 * membership, and the patroller profile that grants the role. Every write here
 * bumps `Membership.updatedAt`, because that is the only watermark offline
 * devices poll.
 */
const ROSTER_INCLUDE = {
  membership: { include: { user: true } },
} as const;

type RosterRow = {
  id: string;
  active: boolean;
  deletedAt: Date | null;
  membership: {
    orgId: string;
    updatedAt: Date;
    deletedAt: Date | null;
    user: {
      firstName: string | null; lastName: string | null;
      nspId: string | null; patrolLevel: string | null;
      email: string | null; phone: string | null;
      emailVerifiedAt: Date | null; phoneVerifiedAt: Date | null;
    };
  };
};

function toResponse(p: RosterRow): PatrollerResponse {
  const u = p.membership.user;
  // A membership tombstone removes the person from the roster just as surely
  // as a profile tombstone does.
  const deletedAt = p.deletedAt ?? p.membership.deletedAt;
  return {
    id: p.id,
    orgId: p.membership.orgId,
    firstName: u.firstName ?? '',
    lastName: u.lastName ?? '',
    displayName: displayName(u),
    nspId: u.nspId ?? '',
    patrolLevel: u.patrolLevel,
    email: u.email,
    phone: u.phone,
    contactVerified: u.emailVerifiedAt !== null || u.phoneVerifiedAt !== null,
    active: p.active && deletedAt === null,
    deletedAt: deletedAt?.toISOString() ?? null,
    updatedAt: p.membership.updatedAt.toISOString(),
  };
}

@Injectable()
export class PatrollerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foldService: TimeClockFoldService,
    private readonly people: PersonService,
    private readonly touch: MembershipTouchService,
    private readonly challenges: ContactChallengeService,
    private readonly sms: SmsService,
  ) {}

  /**
   * Tombstones are included unconditionally: a device that only ever sees live
   * rows can never learn that someone left the roster.
   */
  async list(orgId: string, updatedSince?: string): Promise<PatrollerResponse[]> {
    const rows = await this.prisma.patrollerProfile.findMany({
      where: {
        membership: {
          orgId,
          ...(updatedSince ? { updatedAt: { gt: new Date(updatedSince) } } : {}),
        },
      },
      include: ROSTER_INCLUDE,
      orderBy: [
        { membership: { user: { lastName: 'asc' } } },
        { membership: { user: { firstName: 'asc' } } },
      ],
    });
    return rows.map(toResponse);
  }

  async create(
    orgId: string,
    data: {
      firstName: string; lastName: string; nspId: string;
      patrolLevel?: string | null; email?: string | null; phone?: string | null;
      active: boolean;
    },
  ): Promise<PatrollerResponse> {
    const nspId = normalizeNspId(data.nspId);
    if (!nspId) throw new ConflictException('NSP ID cannot be empty');
    await this.assertNspAvailable(nspId, null);

    const { user } = await this.people.resolveOrCreate({
      nspId,
      email: data.email,
      phone: data.phone,
      firstName: data.firstName,
      lastName: data.lastName,
    });
    await this.prisma.user.update({
      where: { id: user.id },
      data: { patrolLevel: data.patrolLevel?.trim() || null },
    });

    const membership = await this.people.upsertMembership(user.id, orgId);
    const profile = await this.prisma.patrollerProfile.upsert({
      where: { membershipId: membership.id },
      update: { active: data.active, deletedAt: null },
      create: { id: createId(), membershipId: membership.id, active: data.active },
    });
    await this.touch.touch(membership.id);

    return toResponse(await this.findByIdOrThrow(profile.id));
  }

  async patch(
    orgId: string,
    patrollerId: string,
    data: {
      firstName?: string; lastName?: string; nspId?: string;
      patrolLevel?: string | null; email?: string | null; phone?: string | null;
      active?: boolean;
    },
  ): Promise<PatrollerResponse & { closedShiftId: string | null }> {
    const existing = await this.findOrThrow(orgId, patrollerId);
    const userId = existing.membership.userId;

    const nspId = data.nspId !== undefined ? normalizeNspId(data.nspId) : undefined;
    if (nspId && nspId !== existing.membership.user.nspId) {
      await this.assertNspAvailable(nspId, userId);
    }

    const phone = data.phone !== undefined ? normalizePhone(data.phone) : undefined;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...unverifyChangedContacts(existing.membership.user, { email: data.email, phone }),
        ...(data.firstName !== undefined ? { firstName: normalizeNamePart(data.firstName) } : {}),
        ...(data.lastName !== undefined ? { lastName: normalizeNamePart(data.lastName) } : {}),
        ...(nspId !== undefined ? { nspId } : {}),
        ...(data.patrolLevel !== undefined ? { patrolLevel: data.patrolLevel?.trim() || null } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(phone !== undefined ? { phone } : {}),
      },
    });

    if (data.active !== undefined) {
      await this.prisma.patrollerProfile.update({
        where: { id: patrollerId },
        data: { active: data.active },
      });
    }
    // Name, NSP ID and patrol level live on User, so every membership moves.
    await this.touch.touchAllForUser(userId);

    // No open shift outlives its patroller.
    const closedShiftId =
      data.active === false ? await this.closeOpenShift(orgId, patrollerId) : null;

    return { ...toResponse(await this.findByIdOrThrow(patrollerId)), closedShiftId };
  }

  /** Soft delete: the device needs the tombstone to drop the row from its roster. */
  async remove(orgId: string, patrollerId: string): Promise<{ closedShiftId: string | null }> {
    const existing = await this.findOrThrow(orgId, patrollerId);

    await this.prisma.patrollerProfile.update({
      where: { id: patrollerId },
      data: { active: false, deletedAt: new Date() },
    });
    await this.touch.touch(existing.membershipId);

    return { closedShiftId: await this.closeOpenShift(orgId, patrollerId) };
  }

  /**
   * Bulk onboarding. Replaces notify-on-import: an import of 300 strangers
   * should not email 300 people, so staff trigger this explicitly for the rows
   * that still have an unverified contact.
   */
  async sendOnboarding(orgId: string): Promise<{ sent: number; skipped: number }> {
    const rows = await this.prisma.patrollerProfile.findMany({
      where: { deletedAt: null, membership: { orgId, deletedAt: null } },
      include: ROSTER_INCLUDE,
    });

    // With texting off (Plan 29), a patroller known only by a phone has no way
    // to be sent a code, and is skipped like one with no contact at all.
    const canText = await this.sms.enabled();
    let sent = 0;
    let skipped = 0;
    for (const row of rows) {
      const u = row.membership.user;
      if (u.emailVerifiedAt || u.phoneVerifiedAt) { skipped++; continue; }
      const channel = u.email ? 'email' : u.phone && canText ? 'phone' : null;
      if (!channel) { skipped++; continue; }

      try {
        await this.challenges.issue({
          userId: row.membership.userId,
          channel,
          target: (channel === 'email' ? u.email : u.phone)!,
          purpose: 'verify',
        });
      } catch (err) {
        // One person who has had their share of codes is one skipped, not a
        // failed batch that leaves everybody after them unsent.
        if (isTooManyCodes(err)) { skipped++; continue; }
        throw err;
      }
      sent++;
    }
    return { sent, skipped };
  }

  /**
   * TC-S13. Writes an `admin` clock-out and recomputes, rather than editing the
   * shift directly — events stay the single source of truth, so the next
   * recompute agrees with this one.
   */
  private async closeOpenShift(orgId: string, patrollerId: string): Promise<string | null> {
    const open = await this.prisma.timeClockShift.findFirst({
      where: { orgId, patrollerId, status: 'open' },
    });
    if (!open) return null;

    const now = new Date();
    const occurredAt = now.getTime() > open.clockInAt.getTime() ? now : open.clockInAt;

    await this.prisma.$transaction(async (tx) => {
      await tx.timeClockEvent.create({
        data: {
          id: `admin-deactivate:${open.id}`,
          orgId,
          resortId: open.resortId,
          patrollerId,
          type: 'clock_out',
          source: 'admin',
          occurredAt,
          status: 'applied',
          statusNote: 'Closed automatically when the patroller was removed from the roster',
        },
      });
      await this.foldService.recomputeForPatroller(orgId, patrollerId, tx);
    });

    return open.id;
  }

  /** NSP IDs are globally unique — one per human, nationally issued. */
  private async assertNspAvailable(nspId: string, selfUserId: string | null): Promise<void> {
    const holder = await this.prisma.user.findUnique({ where: { nspId } });
    if (holder && holder.id !== selfUserId) {
      throw new ConflictException(
        `NSP ID ${nspId} already belongs to ${displayName(holder)}`,
      );
    }
  }

  // ─── CSV import ────────────────────────────────────────────────────────────

  parseImportFile(buffer: Buffer): {
    headers: string[];
    mapping: Record<string, string | null>;
    rows: Record<string, string>[];
  } {
    const records = parseCsv(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];

    const headers = records.length ? Object.keys(records[0] ?? {}) : [];
    const find = (...candidates: string[]): string | null =>
      headers.find((h) => candidates.includes(h.toLowerCase().replace(/[^a-z]/g, ''))) ?? null;

    return {
      headers,
      mapping: {
        firstName: find('firstname', 'first', 'givenname'),
        lastName: find('lastname', 'last', 'surname', 'familyname'),
        nspId: find('nspid', 'nsp', 'id', 'memberid', 'nspnumber'),
        patrolLevel: find('patrollevel', 'level', 'certification', 'cert'),
        email: find('email', 'emailaddress'),
        phone: find('phone', 'phonenumber', 'mobile', 'cell'),
      },
      rows: records,
    };
  }

  /**
   * Matching is blind by design: NSP ID, then email, then phone, then create.
   * A patroller already known at another mountain is the same person here.
   * Nobody is notified — that is what `sendOnboarding` is for.
   */
  async importRows(
    orgId: string,
    rows: {
      firstName: string; lastName: string; nspId: string;
      patrolLevel?: string | null; email?: string | null; phone?: string | null;
    }[],
    strategy: 'preserve' | 'overwrite',
  ): Promise<{ created: number; updated: number; skipped: number; errors: string[] }> {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const [index, row] of rows.entries()) {
      const nspId = normalizeNspId(row.nspId ?? '');
      const firstName = normalizeNamePart(row.firstName);
      const lastName = normalizeNamePart(row.lastName);
      if (!nspId || !firstName || !lastName) {
        errors.push(`Row ${index + 1}: first name, last name, and NSP ID are all required`);
        skipped++;
        continue;
      }

      try {
        const existingUser = await this.people.resolve({ nspId, email: row.email, phone: row.phone });
        const existingProfile = existingUser
          ? await this.prisma.patrollerProfile.findFirst({
              where: { membership: { orgId, userId: existingUser.id } },
            })
          : null;

        if (existingProfile && !existingProfile.deletedAt && strategy === 'preserve') {
          skipped++;
          continue;
        }

        const { user } = await this.people.resolveOrCreate({
          nspId, email: row.email, phone: row.phone, firstName, lastName,
        });

        if (strategy === 'overwrite') {
          await this.prisma.user.update({
            where: { id: user.id },
            data: {
              firstName, lastName,
              patrolLevel: row.patrolLevel?.trim() || null,
            },
          });
        } else if (!user.patrolLevel && row.patrolLevel?.trim()) {
          await this.prisma.user.update({
            where: { id: user.id },
            data: { patrolLevel: row.patrolLevel.trim() },
          });
        }

        const membership = await this.people.upsertMembership(user.id, orgId);
        await this.prisma.patrollerProfile.upsert({
          where: { membershipId: membership.id },
          update: { active: true, deletedAt: null },
          create: { id: createId(), membershipId: membership.id, active: true },
        });
        await this.touch.touch(membership.id);

        if (existingProfile) updated++;
        else created++;
      } catch (err) {
        errors.push(`Row ${index + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        skipped++;
      }
    }

    return { created, updated, skipped, errors };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async findOrThrow(orgId: string, patrollerId: string) {
    const profile = await this.prisma.patrollerProfile.findFirst({
      where: { id: patrollerId, membership: { orgId } },
      include: { membership: { include: { user: true } } },
    });
    if (!profile) throw new NotFoundException('Patroller not found');
    return profile;
  }

  private async findByIdOrThrow(patrollerId: string): Promise<RosterRow> {
    return this.prisma.patrollerProfile.findUniqueOrThrow({
      where: { id: patrollerId },
      include: ROSTER_INCLUDE,
    });
  }
}

void BadRequestException;
