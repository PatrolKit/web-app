import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_SEASON_CUTOVER,
  seasonAt,
  seasonDates,
  seasonLabel,
  seasonRange,
} from '../common/util/season';
import type { Season, SeasonsResponse } from '../contracts/time-clock.contracts';

/**
 * Entries whose clock-in falls in the season (Plan 55 D12), each by its own resort's
 * calendar: a season starts at local midnight, and the org's resorts need not share a zone.
 */
export async function seasonWhere(
  prisma: PrismaService,
  orgId: string,
  season: number,
): Promise<Prisma.TimeEntryWhereInput> {
  const [org, resorts] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { seasonCutover: true } }),
    prisma.resort.findMany({ where: { orgId }, select: { id: true, timeZone: true } }),
  ]);
  const cutover = org?.seasonCutover ?? DEFAULT_SEASON_CUTOVER;
  if (!resorts.length) return { id: { in: [] } };
  return {
    OR: resorts.map((r) => {
      const { from, to } = seasonRange(season, cutover, r.timeZone);
      return { resortId: r.id, clockInAt: { gte: from, lt: to } };
    }),
  };
}

@Injectable()
export class SeasonService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The seasons there is anything to pick: from the earliest entry's to today's, newest
   * first. "Today" is in the org's first resort's zone — a season turns over at midnight
   * there, and an org with resorts in two zones is a day's rounding either way.
   */
  async list(orgId: string): Promise<SeasonsResponse> {
    const [org, firstResort, earliest] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: orgId }, select: { seasonCutover: true } }),
      this.prisma.resort.findFirst({ where: { orgId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
      this.prisma.timeEntry.findFirst({
        where: { orgId, deletedAt: null },
        orderBy: { clockInAt: 'asc' },
        include: { resort: { select: { timeZone: true } } },
      }),
    ]);
    const cutover = org?.seasonCutover ?? DEFAULT_SEASON_CUTOVER;
    const zone = firstResort?.timeZone ?? 'America/New_York';
    const current = seasonAt(new Date(), cutover, zone);
    const first = earliest ? Math.min(current, seasonAt(earliest.clockInAt, cutover, earliest.resort.timeZone)) : current;

    const season = (startYear: number): Season => ({
      startYear,
      label: seasonLabel(startYear, cutover),
      ...seasonDates(startYear, cutover),
    });
    const seasons: Season[] = [];
    for (let y = current; y >= first; y--) seasons.push(season(y));
    return { cutover, current: season(current), seasons };
  }
}
