import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { SkiSwapSettingsResponse } from '../contracts/ski-swap.contracts';
import type { DevicePinResponse } from '../contracts/devices.contracts';
import { basisPointsToPercent, percentToBasisPoints } from './payouts/money';

const DEFAULT_LABELS_PER_ITEM = 1;
/** A dollar. Below it, the fee outweighs the payout (Plan 25 §7). */
const DEFAULT_PAYOUT_MINIMUM_CENTS = 100;

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
      // Zero for an org that has never set one: a patrol that has not said what
      // its cut is takes nothing, rather than a number somebody guessed.
      commissionPercent: basisPointsToPercent(row?.commissionBasisPoints ?? 0),
      commissionBasisPoints: row?.commissionBasisPoints ?? 0,
      payoutMinimumCents: row?.payoutMinimumCents ?? DEFAULT_PAYOUT_MINIMUM_CENTS,
    };
  }

  /**
   * A patch, not a replacement — the two settings are edited from different
   * controls and neither should clear the other by being saved.
   */
  async upsert(
    orgId: string,
    data: {
      labelsPerItem?: number;
      requireConsignmentScan?: boolean;
      commissionPercent?: string | number;
      payoutMinimumCents?: number;
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
        ...(data.labelsPerItem !== undefined ? { labelsPerItem: data.labelsPerItem } : {}),
        ...(data.requireConsignmentScan !== undefined
          ? { requireConsignmentScan: data.requireConsignmentScan }
          : {}),
        ...(commissionBasisPoints !== undefined ? { commissionBasisPoints } : {}),
        ...(data.payoutMinimumCents !== undefined
          ? { payoutMinimumCents: data.payoutMinimumCents }
          : {}),
      },
      create: {
        orgId,
        labelsPerItem: data.labelsPerItem ?? DEFAULT_LABELS_PER_ITEM,
        requireConsignmentScan: data.requireConsignmentScan ?? false,
        commissionBasisPoints: commissionBasisPoints ?? 0,
        payoutMinimumCents: data.payoutMinimumCents ?? DEFAULT_PAYOUT_MINIMUM_CENTS,
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
      labelsPerItem: row.labelsPerItem,
      requireConsignmentScan: row.requireConsignmentScan,
      taxonomyVersion: row.taxonomyVersion,
      commissionPercent: basisPointsToPercent(row.commissionBasisPoints),
      commissionBasisPoints: row.commissionBasisPoints,
      payoutMinimumCents: row.payoutMinimumCents,
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
