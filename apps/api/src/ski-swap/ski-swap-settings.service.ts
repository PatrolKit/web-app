import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { SkiSwapSettingsResponse } from '../contracts/ski-swap.contracts';
import type { DevicePinResponse } from '../contracts/devices.contracts';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import { basisPointsToPercent, percentToBasisPoints } from './payouts/money';
import { INDEMNIFICATION_CERTIFICATION, accessOf } from './indemnification/indemnification-access';
import { getTabletPin, setTabletPin } from '../devices/tablet-pin';

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
      showUsBootSizes: row?.showUsBootSizes ?? false,
      ...(await this.indemnificationOf(orgId, row)),
      // 1 for an org with no row, matching what the taxonomy service reports —
      // a client that has cached nothing compares against it and fetches.
      taxonomyVersion: row?.taxonomyVersion ?? 1,
      smsEnabled: await this.platform.smsEnabled(),
      // Zero for an org that has never set one: a patrol that has not said what
      // its cut is takes nothing, rather than a number somebody guessed.
      commissionPercent: basisPointsToPercent(row?.commissionBasisPoints ?? 0),
      commissionBasisPoints: row?.commissionBasisPoints ?? 0,
      paypalFee: { flatCents: row?.paypalFeeFlatCents ?? 25, bps: row?.paypalFeeBps ?? 0, capCents: row?.paypalFeeCapCents ?? 0 },
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

  /**
   * Binding indemnification as this org has it (Plan 51): allowed by the
   * platform, on for the web and the iPads, and who certified, by name. The
   * deprecated `nssraMember` fields mirror it for iPads that still read them.
   */
  private async indemnificationOf(
    orgId: string,
    row: { indemnificationWeb: boolean; indemnificationIpad: boolean; indemnificationCertifiedBy: string | null; indemnificationCertifiedAt: Date | null } | null,
  ): Promise<Pick<SkiSwapSettingsResponse, 'indemnification' | 'nssraMember' | 'nssraMemberSetBy' | 'nssraMemberSetAt'>> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { indemnificationAllowed: true } });
    const access = accessOf(org, row);
    const by = row?.indemnificationCertifiedBy
      ? await this.prisma.user.findUnique({
          where: { id: row.indemnificationCertifiedBy },
          select: { firstName: true, lastName: true },
        })
      : null;
    // A name or nothing: this reaches every reporter and the check-in iPads,
    // and an email or phone number isn't theirs to read.
    const name = by ? [by.firstName, by.lastName].map((s) => s?.trim()).filter(Boolean).join(' ') : '';
    const certifiedAt = row?.indemnificationCertifiedAt?.toISOString() ?? null;
    const on = access.web || access.ipad;
    return {
      indemnification: { ...access, certification: INDEMNIFICATION_CERTIFICATION, certifiedBy: name || null, certifiedAt },
      nssraMember: on,
      nssraMemberSetBy: on ? name || null : null,
      nssraMemberSetAt: on ? certifiedAt : null,
    };
  }

  async upsert(
    orgId: string,
    data: {
      requireConsignmentScan?: boolean;
      commissionPercent?: string | number;
      barcodesPerTicket?: 1 | 2;
      showUsBootSizes?: boolean;
      paypalFee?: { flatCents: number; bps: number; capCents: number };
      indemnificationWeb?: boolean;
      indemnificationIpad?: boolean;
      certifyIndemnification?: true;
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

    // Binding indemnification (Plan 51): only while the platform allows the
    // org, and turning either switch on certifies, so it's refused without the
    // certification and carries who certified and when.
    const indemnification: { indemnificationWeb?: boolean; indemnificationIpad?: boolean; indemnificationCertifiedBy?: string | null; indemnificationCertifiedAt?: Date } = {};
    const fromWeb = before?.indemnificationWeb ?? false;
    const fromIpad = before?.indemnificationIpad ?? false;
    const webChanged = data.indemnificationWeb !== undefined && data.indemnificationWeb !== fromWeb;
    const ipadChanged = data.indemnificationIpad !== undefined && data.indemnificationIpad !== fromIpad;
    if (webChanged || ipadChanged) {
      const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { indemnificationAllowed: true } });
      if (!org?.indemnificationAllowed) {
        throw new ForbiddenException({ code: 'INDEMNIFICATION_OFF', message: 'Binding indemnification isn’t available to this organization. A platform admin allows it.' });
      }
      const turningOn = (webChanged && data.indemnificationWeb) || (ipadChanged && data.indemnificationIpad);
      if (turningOn && data.certifyIndemnification !== true) {
        throw new BadRequestException(`Turning binding indemnification on needs the certification: ${INDEMNIFICATION_CERTIFICATION}`);
      }
      if (webChanged) indemnification.indemnificationWeb = data.indemnificationWeb;
      if (ipadChanged) indemnification.indemnificationIpad = data.indemnificationIpad;
      if (turningOn) {
        indemnification.indemnificationCertifiedBy = actorId ?? null;
        indemnification.indemnificationCertifiedAt = new Date();
      }
    }

    const row = await this.prisma.skiSwapSettings.upsert({
      where: { orgId },
      update: {
        ...(data.requireConsignmentScan !== undefined
          ? { requireConsignmentScan: data.requireConsignmentScan }
          : {}),
        ...(commissionBasisPoints !== undefined ? { commissionBasisPoints } : {}),
        ...(data.barcodesPerTicket !== undefined ? { barcodesPerTicket: data.barcodesPerTicket } : {}),
        ...(data.showUsBootSizes !== undefined ? { showUsBootSizes: data.showUsBootSizes } : {}),
        ...(data.paypalFee ? { paypalFeeFlatCents: data.paypalFee.flatCents, paypalFeeBps: data.paypalFee.bps, paypalFeeCapCents: data.paypalFee.capCents } : {}),
        ...indemnification,
      },
      create: {
        orgId,
        requireConsignmentScan: data.requireConsignmentScan ?? false,
        commissionBasisPoints: commissionBasisPoints ?? 0,
        barcodesPerTicket: data.barcodesPerTicket ?? 1,
        showUsBootSizes: data.showUsBootSizes ?? false,
        ...(data.paypalFee ? { paypalFeeFlatCents: data.paypalFee.flatCents, paypalFeeBps: data.paypalFee.bps, paypalFeeCapCents: data.paypalFee.capCents } : {}),
        ...indemnification,
      },
    });

    if (webChanged || ipadChanged) {
      await this.prisma.auditLog.create({
        data: {
          actorType: 'user',
          actorId: actorId ?? null,
          orgId,
          action: 'ski_swap.settings.indemnification',
          metadata: {
            ...(webChanged ? { web: { from: fromWeb, to: data.indemnificationWeb } } : {}),
            ...(ipadChanged ? { ipad: { from: fromIpad, to: data.indemnificationIpad } } : {}),
            certified: 'indemnificationCertifiedAt' in indemnification,
          },
        },
      });
    }

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
      showUsBootSizes: row.showUsBootSizes,
      ...(await this.indemnificationOf(orgId, row)),
      taxonomyVersion: row.taxonomyVersion,
      smsEnabled: await this.platform.smsEnabled(),
      commissionPercent: basisPointsToPercent(row.commissionBasisPoints),
      commissionBasisPoints: row.commissionBasisPoints,
      paypalFee: { flatCents: row.paypalFeeFlatCents, bps: row.paypalFeeBps, capCents: row.paypalFeeCapCents },
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
