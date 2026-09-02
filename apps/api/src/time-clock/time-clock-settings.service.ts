import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createId } from '@paralleldrive/cuid2';
import type { TimeClockSettingsResponse } from '../contracts/time-clock.contracts';
import type { DevicePinResponse } from '../contracts/devices.contracts';

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

  /** Null for an org that has never set one, which means the sheet opens unguarded. */
  async getDevicePin(orgId: string): Promise<DevicePinResponse> {
    const row = await this.prisma.timeClockSettings.findUnique({ where: { orgId } });
    return { devicePin: row?.devicePin ?? null };
  }

  /**
   * `null` removes the gate.
   *
   * Audited, and the value never is: a PIN nobody can account for is worse than
   * one everybody knows, but the log is not the place to leak it to readers who
   * were refused the endpoint that returns it.
   */
  async setDevicePin(
    orgId: string,
    devicePin: string | null,
    actorId: string,
    ipAddress?: string,
  ): Promise<DevicePinResponse> {
    await this.get(orgId); // ensure the row exists
    const row = await this.prisma.timeClockSettings.update({
      where: { orgId },
      data: { devicePin },
    });
    await this.prisma.auditLog.create({
      data: {
        actorType: 'user',
        actorId,
        orgId,
        action:
          devicePin === null ? 'time_clock.device_pin.cleared' : 'time_clock.device_pin.updated',
        ipAddress: ipAddress ?? null,
      },
    });
    return { devicePin: row.devicePin };
  }
}
