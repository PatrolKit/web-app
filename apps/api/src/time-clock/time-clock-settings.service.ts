import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createId } from '@paralleldrive/cuid2';
import type { TimeClockSettingsResponse } from '../contracts/time-clock.contracts';
import type { DevicePinResponse } from '../contracts/devices.contracts';
import { getTabletPin, setTabletPin } from '../devices/tablet-pin';

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

  /** The org's tablet PIN (Plan 56 D5), for iPad builds that still ask their module. */
  async getDevicePin(orgId: string): Promise<DevicePinResponse> {
    return getTabletPin(this.prisma, orgId);
  }

  /** Sets the org's tablet PIN (Plan 56 D5); this module's own column is no longer read. */
  async setDevicePin(orgId: string, devicePin: string | null, actorId: string, ipAddress?: string): Promise<DevicePinResponse> {
    return setTabletPin(this.prisma, orgId, devicePin, actorId, ipAddress);
  }
}
