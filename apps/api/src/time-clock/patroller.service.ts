import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PersonService } from '../common/identity/person.service';
import { IS_MEMBER } from '../common/identity/membership-kinds';
import { displayName } from '../common/util/person';
import type { DevicePatrollerResponse, PatrollerResponse } from '../contracts/time-clock.contracts';
import { decodeCursor, encodeCursor } from '../common/util/cursor';

/**
 * The time clock's roster is the org's members (Plan 57 D1). People are added,
 * edited and removed on Members; this only reads them, for the iPads and for
 * staff screens that name who is on shift.
 *
 * A roster row is assembled from three tables: the person (`User`), their
 * membership, and the member record. `Membership.updatedAt` is the watermark
 * offline devices poll, and every write that changes a row bumps it.
 */
const ROSTER_INCLUDE = {
  membership: { include: { user: true } },
} as const;

type RosterRow = {
  id: string;
  active: boolean;
  deletedAt: Date | null;
  clockPin: string | null;
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
  // as a record tombstone does.
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

/**
 * A terminal's row (Plan 55 D10, Plan 57 D9): no contact details, and the PIN of
 * a member with no NSP ID, which the iPad verifies offline as it does an NSP ID.
 */
function forDevice(p: RosterRow): DevicePatrollerResponse {
  const { email: _email, phone: _phone, contactVerified: _verified, ...rest } = toResponse(p);
  return { ...rest, clockPin: p.membership.user.nspId ? null : p.clockPin };
}

/** A walk's page of the roster: a big patrol's whole roster in a request or two. */
const WALK_PAGE = 500;

@Injectable()
export class PatrollerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly people: PersonService,
  ) {}

  /**
   * Tombstones are included unconditionally: a device that only ever sees live
   * rows can never learn that someone left the roster.
   *
   * `walk=true` pages the delta in `(membership.updatedAt, id)` order with a
   * cursor taken before the read (Plan 55 D7), as the shift walk does.
   */
  async list(
    orgId: string,
    q: { updatedSince?: string; walk?: boolean; after?: string },
    opts: { forDevice: boolean },
  ): Promise<(PatrollerResponse | DevicePatrollerResponse)[] | {
    patrollers: (PatrollerResponse | DevicePatrollerResponse)[]; syncedAt: string; nextAfter?: string;
  }> {
    await this.mendMemberRecords(orgId);
    const shape = (r: RosterRow) => (opts.forDevice ? forDevice(r) : toResponse(r));
    const since = q.updatedSince ? { updatedAt: { gt: new Date(q.updatedSince) } } : {};
    // A seller who is not a member never had a record, so isn't here; one whose
    // record was removed is here as a tombstone, for the devices.
    const where = { membership: { orgId, ...since } };

    if (!q.walk && !q.after) {
      const rows = await this.prisma.patrollerProfile.findMany({
        where,
        include: ROSTER_INCLUDE,
        orderBy: [
          { membership: { user: { lastName: 'asc' } } },
          { membership: { user: { firstName: 'asc' } } },
        ],
      });
      return rows.map(shape);
    }

    const syncedAt = new Date();
    const cursor = q.after ? decodeCursor(q.after) : null;
    if (q.after && !cursor) throw new BadRequestException('That page cursor is not one of ours.');
    const rows = await this.prisma.patrollerProfile.findMany({
      where: {
        ...where,
        ...(cursor
          ? {
              OR: [
                { membership: { updatedAt: { gt: cursor.updatedAt } } },
                { membership: { updatedAt: cursor.updatedAt }, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      include: ROSTER_INCLUDE,
      orderBy: [{ membership: { updatedAt: 'asc' } }, { id: 'asc' }],
      take: WALK_PAGE,
    });
    const last = rows[rows.length - 1];
    return {
      patrollers: rows.map(shape),
      syncedAt: syncedAt.toISOString(),
      ...(last && rows.length === WALK_PAGE ? { nextAfter: encodeCursor(last.membership.updatedAt, last.id) } : {}),
    };
  }

  /**
   * Members who became members by a path that forgot the record (a permission
   * granted directly, say) get one here, so the roster is every member (D1).
   */
  private async mendMemberRecords(orgId: string): Promise<void> {
    const missing = await this.prisma.membership.findMany({
      where: {
        orgId,
        deletedAt: null,
        AND: [
          IS_MEMBER,
          { OR: [{ patrollerProfile: { is: null } }, { patrollerProfile: { is: { deletedAt: { not: null } } } }] },
        ],
      },
      select: { id: true },
    });
    for (const m of missing) {
      await this.people.ensureMemberRecord(m.id);
      await this.prisma.membership.update({ where: { id: m.id }, data: { updatedAt: new Date() } });
    }
  }
}
