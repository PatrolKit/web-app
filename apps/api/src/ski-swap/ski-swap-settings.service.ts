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
    return {
      labelsPerItem: row?.labelsPerItem ?? DEFAULT_LABELS_PER_ITEM,
      // Off for an org that has never said otherwise: the extra step belongs to
      // organisations that asked for it.
      requireConsignmentScan: row?.requireConsignmentScan ?? false,
      // 1 for an org with no row, matching what the taxonomy service reports —
      // a client that has cached nothing compares against it and fetches.
      taxonomyVersion: row?.taxonomyVersion ?? 1,
    };
  }

  /**
   * A patch, not a replacement — the two settings are edited from different
   * controls and neither should clear the other by being saved.
   */
  async upsert(
    orgId: string,
    data: { labelsPerItem?: number; requireConsignmentScan?: boolean },
  ): Promise<SkiSwapSettingsResponse> {
    const row = await this.prisma.skiSwapSettings.upsert({
      where: { orgId },
      update: {
        ...(data.labelsPerItem !== undefined ? { labelsPerItem: data.labelsPerItem } : {}),
        ...(data.requireConsignmentScan !== undefined
          ? { requireConsignmentScan: data.requireConsignmentScan }
          : {}),
      },
      create: {
        orgId,
        labelsPerItem: data.labelsPerItem ?? DEFAULT_LABELS_PER_ITEM,
        requireConsignmentScan: data.requireConsignmentScan ?? false,
      },
    });
    return {
      labelsPerItem: row.labelsPerItem,
      requireConsignmentScan: row.requireConsignmentScan,
      taxonomyVersion: row.taxonomyVersion,
    };
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
