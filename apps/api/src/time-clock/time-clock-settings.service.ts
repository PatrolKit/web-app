import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createId } from '@paralleldrive/cuid2';
import type { TimeClockSettingsResponse } from '../contracts/time-clock.contracts';

@Injectable()
export class TimeClockSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates the row on first read so a fresh org never 404s a device. */
  async get(orgId: string): Promise<TimeClockSettingsResponse> {
    const existing = await this.prisma.timeClockSettings.findUnique({ where: { orgId } });
    const settings =
      existing ??
      (await this.prisma.timeClockSettings.create({ data: { id: createId(), orgId } }));

    return {
      orgId: settings.orgId,
      autoCloseLocalTime: settings.autoCloseLocalTime,
      autoCloseAfterHours: settings.autoCloseAfterHours,
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  async update(
    orgId: string,
    data: { autoCloseLocalTime?: string; autoCloseAfterHours?: number },
  ): Promise<TimeClockSettingsResponse> {
    await this.get(orgId); // ensure the row exists
    const settings = await this.prisma.timeClockSettings.update({ where: { orgId }, data });
    return {
      orgId: settings.orgId,
      autoCloseLocalTime: settings.autoCloseLocalTime,
      autoCloseAfterHours: settings.autoCloseAfterHours,
      updatedAt: settings.updatedAt.toISOString(),
    };
  }
}
