import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { SkiSwapSettingsResponse } from '../contracts/ski-swap.contracts';
import type { DevicePinResponse } from '../contracts/devices.contracts';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import { basisPointsToPercent, percentToBasisPoints } from './payouts/money';

const DEFAULT_LABELS_PER_ITEM = 1;

/** Barcodes on a tall item tag: 2 only when asked for, 1 for an org with no row. */
export function barcodesOf(row: { barcodesPerTicket: number } | null | undefined): 1 | 2 {
  return row?.barcodesPerTicket === 2 ? 2 : 1;
}

@Injectable()
export class SkiSwapSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformSettingsService,
  ) {}

  async get(orgId: string): Promise<SkiSwapSettingsResponse> {
    const row = await this.prisma.skiSwapSettings.findUnique({ where: { orgId } });
    return {
      labelsPerItem: await this.runningSwapLabelsPerItem(orgId),
      // Off for an org that has never said otherwise: the extra step belongs to
      // organisations that asked for it.
      requireConsignmentScan: row?.requireConsignmentScan ?? false,
      barcodesPerTicket: barcodesOf(row),
      // 1 for an org with no row, matching what the taxonomy service reports —
      // a client that has cached nothing compares against it and fetches.
      taxonomyVersion: row?.taxonomyVersion ?? 1,
      smsEnabled: await this.platform.smsEnabled(),
      // Zero for an org that has never set one: a patrol that has not said what
      // its cut is takes nothing, rather than a number somebody guessed.
      commissionPercent: basisPointsToPercent(row?.commissionBasisPoints ?? 0),
      commissionBasisPoints: row?.commissionBasisPoints ?? 0,
    };
  }

  /**
   * A patch, not a replacement — the settings are edited from different
   * controls and none should clear another by being saved.
   */
  /**
   * Labels per item moved to the swap. It is still answered here, for iPads
   * that read it from settings: the value of the org's running swap — the most
   * recently changed, if more than one is — or of its newest swap otherwise.
   */
  private async runningSwapLabelsPerItem(orgId: string): Promise<number> {
    const swap =
      (await this.prisma.skiSwap.findFirst({
        where: { orgId, active: true },
        orderBy: { updatedAt: 'desc' },
        select: { labelsPerItem: true },
      })) ??
      (await this.prisma.skiSwap.findFirst({
        where: { orgId },
        orderBy: { createdAt: 'desc' },
        select: { labelsPerItem: true },
      }));
    return swap?.labelsPerItem ?? DEFAULT_LABELS_PER_ITEM;
  }

  async upsert(
    orgId: string,
    data: {
      requireConsignmentScan?: boolean;
      commissionPercent?: string | number;
      barcodesPerTicket?: 1 | 2;
    },
    actorId?: string,
  ): Promise<SkiSwapSettingsResponse> {
    // Percent in, basis points stored. The only conversion, at the only edge.
    let commissionBasisPoints: number | undefined;
    if (data.commissionPercent !== undefined) {
      const bps = percentToBasisPoints(data.commissionPercent);
      if (bps === null) {
        throw new BadRequestException(
          'The commission must be a percentage between 0 and 100, with at most two decimal places',
        );
      }
      commissionBasisPoints = bps;
    }

    const before = await this.prisma.skiSwapSettings.findUnique({ where: { orgId } });

    const row = await this.prisma.skiSwapSettings.upsert({
      where: { orgId },
      update: {
        ...(data.requireConsignmentScan !== undefined
          ? { requireConsignmentScan: data.requireConsignmentScan }
          : {}),
        ...(commissionBasisPoints !== undefined ? { commissionBasisPoints } : {}),
        ...(data.barcodesPerTicket !== undefined ? { barcodesPerTicket: data.barcodesPerTicket } : {}),
      },
      create: {
        orgId,
        requireConsignmentScan: data.requireConsignmentScan ?? false,
        commissionBasisPoints: commissionBasisPoints ?? 0,
        barcodesPerTicket: data.barcodesPerTicket ?? 1,
      },
    });

    // Audited with both sides of the change. What the patrol's cut was on the
    // day of a swap is the sort of question that gets asked a year later, by
    // somebody who is already unhappy.
    if (commissionBasisPoints !== undefined && commissionBasisPoints !== (before?.commissionBasisPoints ?? 0)) {
      await this.prisma.auditLog.create({
        data: {
          actorType: 'user',
          actorId: actorId ?? null,
          orgId,
          action: 'ski_swap.commission.updated',
          metadata: {
            from: basisPointsToPercent(before?.commissionBasisPoints ?? 0),
            to: basisPointsToPercent(commissionBasisPoints),
          },
        },
      });
    }

    return {
      labelsPerItem: await this.runningSwapLabelsPerItem(orgId),
      requireConsignmentScan: row.requireConsignmentScan,
      barcodesPerTicket: barcodesOf(row),
      taxonomyVersion: row.taxonomyVersion,
      smsEnabled: await this.platform.smsEnabled(),
      commissionPercent: basisPointsToPercent(row.commissionBasisPoints),
      commissionBasisPoints: row.commissionBasisPoints,
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
