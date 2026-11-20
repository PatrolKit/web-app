import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NOTE, TimeClockFoldService } from './fold.service';
import { TimeClockSweepService } from './sweep.service';
import { ENTRY_INCLUDE, toResponse } from './time-entry.service';
import type { MemberClockEvent, MemberClockResult, TimeEntryResponse } from '../contracts/time-clock.contracts';

/**
 * A patroller's own clock, from a phone or the website (Plan 59 §5). Online only (R7): an
 * event happens when it arrives, except a clock-out time she chose (R6). She acts only on
 * herself, while on the roster and active (R9).
 */
@Injectable()
export class MemberClockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foldService: TimeClockFoldService,
    private readonly sweepService: TimeClockSweepService,
  ) {}

  async shift(orgId: string, membershipId: string): Promise<{ entry: TimeEntryResponse | null }> {
    const patrollerId = await this.patrollerOf(orgId, membershipId);
    await this.sweepService.sweep({ orgId, patrollerId });
    return { entry: await this.openShift(orgId, patrollerId) };
  }

  async entries(orgId: string, membershipId: string, take = 20): Promise<TimeEntryResponse[]> {
    const patrollerId = await this.patrollerOf(orgId, membershipId);
    await this.sweepService.sweep({ orgId, patrollerId });
    const rows = await this.prisma.timeEntry.findMany({
      where: { orgId, patrollerId, deletedAt: null },
      include: ENTRY_INCLUDE,
      orderBy: [{ clockInAt: 'desc' }, { id: 'asc' }],
      take,
    });
    return rows.map(toResponse);
  }

  async submit(orgId: string, membershipId: string, e: MemberClockEvent): Promise<MemberClockResult> {
    const patrollerId = await this.patrollerOf(orgId, membershipId);

    // A retry returns what the first try got; someone else's id is refused.
    const held = await this.prisma.timeClockEvent.findUnique({ where: { id: e.id } });
    if (held) {
      if (held.orgId !== orgId || held.patrollerId !== patrollerId) {
        return { event: { id: e.id, status: 'rejected', note: 'id_conflict' }, entry: null };
      }
      return this.result(orgId, patrollerId, e.id);
    }

    // Nothing reaches her log ahead of a sweep that is due (E2, E12).
    await this.sweepService.sweep({ orgId, patrollerId });
    const now = new Date();
    const location = e.location
      ? { latitude: e.location.lat, longitude: e.location.lon, accuracyM: e.location.accuracyM ?? null }
      : {};

    if (e.type === 'clock_in') {
      const resort = await this.prisma.resort.findFirst({ where: { id: e.resortId, orgId, deletedAt: null } });
      if (!resort) throw new NotFoundException('Resort not found');
      const open = await this.openShift(orgId, patrollerId);
      if (open) {
        throw new ConflictException({
          message: `You're still clocked in at ${open.resortName ?? 'another resort'}. Close that shift first.`,
          code: 'on_shift',
          details: { entry: open },
        });
      }
      await this.prisma.timeClockEvent.create({
        data: {
          id: e.id, orgId, resortId: resort.id, patrollerId, type: 'clock_in',
          dutyType: e.dutyType, dutyNote: e.dutyNote ?? null, source: 'member', occurredAt: now, ...location,
        },
      });
    } else {
      const named = await this.prisma.timeClockEvent.findFirst({
        where: { id: e.entryId, orgId, patrollerId, type: 'clock_in' },
      });
      if (!named) throw new NotFoundException('Shift not found');
      let occurredAt = now;
      if (e.chosenAt) {
        const open = await this.openShift(orgId, patrollerId);
        const from = open ? new Date(open.clockInAt) : named.occurredAt;
        occurredAt = new Date(e.chosenAt);
        if (occurredAt.getTime() < from.getTime() || occurredAt.getTime() > now.getTime()) {
          throw new BadRequestException('Choose a time between the clock-in and now.');
        }
      }
      await this.prisma.timeClockEvent.create({
        data: {
          id: e.id, orgId, resortId: named.resortId, patrollerId, type: 'clock_out', source: 'member',
          occurredAt, entryId: e.entryId, ...(e.chosenAt ? { statusNote: NOTE.chosenTime } : {}), ...location,
        },
      });
    }

    await this.foldService.recomputeForPatroller(orgId, patrollerId);
    return this.result(orgId, patrollerId, e.id);
  }

  /** The event as the fold left it, and the shift it belongs to. */
  private async result(orgId: string, patrollerId: string, eventId: string): Promise<MemberClockResult> {
    const event = await this.prisma.timeClockEvent.findUniqueOrThrow({ where: { id: eventId } });
    // A clock-out names a shift, or a duplicate that names one.
    const named = event.entryId
      ? await this.prisma.timeClockEvent.findUnique({ where: { id: event.entryId }, select: { entryId: true } })
      : null;
    const ids = [event.id, event.entryId, named?.entryId].filter((id): id is string => !!id);
    const row = await this.prisma.timeEntry.findFirst({
      where: { orgId, patrollerId, deletedAt: null, OR: [{ closeEventId: event.id }, { id: { in: ids } }] },
      include: ENTRY_INCLUDE,
    });
    return {
      event: { id: event.id, status: event.status as MemberClockResult['event']['status'], note: event.statusNote },
      entry: row ? toResponse(row) : null,
    };
  }

  private async openShift(orgId: string, patrollerId: string): Promise<TimeEntryResponse | null> {
    const row = await this.prisma.timeEntry.findFirst({
      where: { orgId, patrollerId, status: 'open', deletedAt: null },
      include: ENTRY_INCLUDE,
    });
    return row ? toResponse(row) : null;
  }

  /** On the roster and active (R9); the guards have already checked the membership. */
  private async patrollerOf(orgId: string, membershipId: string): Promise<string> {
    const p = await this.prisma.patrollerProfile.findFirst({
      where: { membershipId, deletedAt: null, active: true, membership: { orgId } },
      select: { id: true },
    });
    if (!p) throw new ForbiddenException("You're not on this organization's time clock.");
    return p.id;
  }
}
