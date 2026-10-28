import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TimeClockFoldService, writeAdminClose } from './fold.service';

/**
 * No open entry outlives its member (TC-S13, Plan 57 D5). Making someone
 * inactive or removing them writes an `admin` clock-out and recomputes, rather
 * than editing the entry: events stay the single source of truth, so the next
 * recompute agrees with this one.
 *
 * Exported for Members, which is where people are made inactive or removed.
 */
@Injectable()
export class ClockOutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foldService: TimeClockFoldService,
  ) {}

  /** The open entry a member would lose, for a warning before the change. */
  async openEntryOf(orgId: string, membershipId: string) {
    return this.prisma.timeEntry.findFirst({
      where: { orgId, status: 'open', deletedAt: null, patroller: { membershipId } },
      include: { resort: { select: { name: true } } },
    });
  }

  /** Closes it, if there is one, and says which. */
  async closeFor(orgId: string, membershipId: string, actorId?: string): Promise<string | null> {
    const open = await this.openEntryOf(orgId, membershipId);
    if (!open) return null;

    const now = new Date();
    const occurredAt = now.getTime() > open.clockInAt.getTime() ? now : open.clockInAt;

    await this.prisma.$transaction(async (tx) => {
      await writeAdminClose(tx, {
        id: `admin-deactivate:${open.id}`,
        orgId,
        resortId: open.resortId,
        patrollerId: open.patrollerId,
        occurredAt,
        statusNote: 'Closed automatically when the member was made inactive or removed',
      });
      await this.foldService.recomputeForPatroller(orgId, open.patrollerId, tx);
      // On the entry itself, so its history says why it ended (Plan 55 D11).
      await tx.auditLog.create({
        data: {
          actorType: 'user',
          actorId: actorId ?? null,
          orgId,
          action: 'time_clock.entry.closed_by_roster',
          targetType: 'time_entry',
          targetId: open.id,
          metadata: { closedAt: occurredAt.toISOString() },
        },
      });
    });
    return open.id;
  }
}
