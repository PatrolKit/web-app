import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { displayName } from '../common/util/person';
import type { HoursReportRow } from '../contracts/time-clock.contracts';

@Injectable()
export class TimeClockReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** Closed shifts only — an open shift has no duration to report yet. */
  async hours(
    orgId: string,
    q: { from?: string; to?: string; resortId?: string; dutyType?: string },
  ): Promise<HoursReportRow[]> {
    const where: Prisma.TimeClockShiftWhereInput = {
      orgId,
      status: 'closed',
      clockOutAt: { not: null },
      ...(q.resortId ? { resortId: q.resortId } : {}),
      ...(q.dutyType ? { dutyType: q.dutyType } : {}),
    };
    if (q.from || q.to) {
      where.clockInAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }

    const shifts = await this.prisma.timeClockShift.findMany({
      where,
      include: {
        patroller: { include: { membership: { select: { user: true } } } },
      },
    });

    const byPatroller = new Map<string, HoursReportRow>();
    for (const s of shifts) {
      if (!s.clockOutAt) continue;
      const minutes = Math.max(
        0,
        Math.round((s.clockOutAt.getTime() - s.clockInAt.getTime()) / 60_000),
      );

      let row = byPatroller.get(s.patrollerId);
      if (!row) {
        row = {
          patrollerId: s.patrollerId,
          patrollerName: displayName(s.patroller.membership.user),
          nspId: s.patroller.membership.user.nspId ?? '',
          patrolLevel: s.patroller.membership.user.patrolLevel,
          shiftCount: 0,
          totalMinutes: 0,
          minutesByDutyType: {},
        };
        byPatroller.set(s.patrollerId, row);
      }

      row.shiftCount += 1;
      row.totalMinutes += minutes;
      row.minutesByDutyType[s.dutyType] = (row.minutesByDutyType[s.dutyType] ?? 0) + minutes;
    }

    return [...byPatroller.values()].sort((a, b) =>
      a.patrollerName.localeCompare(b.patrollerName),
    );
  }

  async hoursCsv(
    orgId: string,
    q: { from?: string; to?: string; resortId?: string; dutyType?: string },
  ): Promise<string> {
    const rows = await this.hours(orgId, q);
    const dutyTypes = [...new Set(rows.flatMap((r) => Object.keys(r.minutesByDutyType)))].sort();

    const header = ['Patroller', 'NSP ID', 'Patrol level', 'Shifts', 'Total hours', ...dutyTypes.map((d) => `${d} hours`)];
    const lines = [header.join(',')];

    for (const r of rows) {
      lines.push(
        [
          csvCell(r.patrollerName),
          csvCell(r.nspId),
          csvCell(r.patrolLevel ?? ''),
          String(r.shiftCount),
          hours(r.totalMinutes),
          ...dutyTypes.map((d) => hours(r.minutesByDutyType[d] ?? 0)),
        ].join(','),
      );
    }
    return lines.join('\n') + '\n';
  }
}

function hours(minutes: number): string {
  return (minutes / 60).toFixed(2);
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
