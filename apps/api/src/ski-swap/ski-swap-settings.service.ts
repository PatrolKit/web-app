import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { SkiSwapSettingsResponse } from '../contracts/ski-swap.contracts';
import type { DevicePinResponse } from '../contracts/devices.contracts';

const DEFAULT_LABELS_PER_ITEM = 1;

@Injectable()
export class SkiSwapSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(orgId: string): Promise<SkiSwapSettingsResponse> {
    const row = await this.prisma.skiSwapSettings.findUnique({ where: { orgId } });
    return { labelsPerItem: row?.labelsPerItem ?? DEFAULT_LABELS_PER_ITEM };
  }

  async upsert(orgId: string, labelsPerItem: number): Promise<SkiSwapSettingsResponse> {
    const row = await this.prisma.skiSwapSettings.upsert({
      where: { orgId },
      update: { labelsPerItem },
      create: { orgId, labelsPerItem },
    });
    return { labelsPerItem: row.labelsPerItem };
  }

  /** Null for an org that has never set one, which means the sheet opens unguarded. */
  async getDevicePin(orgId: string): Promise<DevicePinResponse> {
    const row = await this.prisma.skiSwapSettings.findUnique({ where: { orgId } });
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
    const row = await this.prisma.skiSwapSettings.upsert({
      where: { orgId },
      update: { devicePin },
      create: { orgId, devicePin },
    });
    await this.prisma.auditLog.create({
      data: {
        actorType: 'user',
        actorId,
        orgId,
        action: devicePin === null ? 'ski_swap.device_pin.cleared' : 'ski_swap.device_pin.updated',
        ipAddress: ipAddress ?? null,
      },
    });
    return { devicePin: row.devicePin };
  }
}
