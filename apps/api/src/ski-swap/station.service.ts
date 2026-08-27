import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { SkuService } from './sku.service';
import type { DeviceRole } from '../contracts/devices.contracts';
import type { StationResponse } from '../contracts/ski-swap.contracts';

/** Which slot a device occupies is decided by what kind of device it is. */
const ATTENDANT_ROLE: DeviceRole = 'ski_swap.staff_check_in';
const BRIDGE_ROLE: DeviceRole = 'ski_swap.print_bridge';

// The printer hangs off the bridge: a station reaches it through the box that
// drives it, so there is one place recording which printer is where.
const INCLUDE = {
  attendant: true,
  bridge: { include: { bridgedPrinter: true } },
} as const;

type StationRow = {
  id: string;
  name: string;
  code: string;
  createdAt: Date;
  attendantDeviceId: string | null;
  bridgeDeviceId: string | null;
  attendant: { name: string; lastSeenAt: Date | null } | null;
  bridge: {
    name: string;
    lastSeenAt: Date | null;
    bridgedPrinter: { id: string; name: string } | null;
  } | null;
};

/**
 * Check-in stations: a counter, its hardware, and the SKU namespace it mints in.
 *
 * One concept covers both kinds. A station with a staff tablet is *staffed*; one
 * without is *self-service* and needs a bridge, because a seller has no other way
 * to get a tag. The kind is derived rather than stored, so it cannot contradict
 * the hardware actually bound to it.
 *
 * The station is also the layer that survives replacing either piece of hardware
 * beneath it, which is why it owns the code that namespaces every SKU checked in
 * here — held on a device, a failed tablet would take the namespace with it.
 */
@Injectable()
export class StationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skuService: SkuService,
  ) {}

  async list(orgId: string): Promise<StationResponse[]> {
    const stations = await this.prisma.checkinStation.findMany({
      where: { orgId, deletedAt: null },
      include: INCLUDE,
      orderBy: { code: 'asc' },
    });
    return stations.map(toResponse);
  }

  async create(orgId: string, name: string): Promise<StationResponse> {
    const code = await this.skuService.allocateCode(orgId);
    const station = await this.prisma.checkinStation.create({
      data: { id: createId(), orgId, name, code },
      include: INCLUDE,
    });
    return toResponse(station);
  }

  /**
   * Renames a station, or re-points it at different hardware.
   *
   * Re-binding has to be possible because hardware dies mid-swap. Queued jobs
   * survive it: they belong to the station, not to the box underneath.
   */
  async update(
    orgId: string,
    stationId: string,
    data: {
      name?: string;
      attendantDeviceId?: string | null;
      bridgeDeviceId?: string | null;
    },
  ): Promise<StationResponse> {
    const station = await this.find(orgId, stationId);

    if (data.attendantDeviceId) {
      await this.assertDeviceFree(orgId, data.attendantDeviceId, ATTENDANT_ROLE, station.id);
    }
    if (data.bridgeDeviceId) {
      await this.assertDeviceFree(orgId, data.bridgeDeviceId, BRIDGE_ROLE, station.id);
    }

    const updated = await this.prisma.checkinStation.update({
      where: { id: station.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.attendantDeviceId !== undefined ? { attendantDeviceId: data.attendantDeviceId } : {}),
        ...(data.bridgeDeviceId !== undefined ? { bridgeDeviceId: data.bridgeDeviceId } : {}),
      },
      include: INCLUDE,
    });
    return toResponse(updated);
  }

  /**
   * Soft delete — the code stays claimed until then, so SKUs never collide.
   *
   * The hardware is released. A retired station holding a bridge would keep that
   * bridge, and the printer behind it, out of circulation permanently.
   */
  async remove(orgId: string, stationId: string): Promise<void> {
    const station = await this.find(orgId, stationId);
    await this.prisma.checkinStation.update({
      where: { id: station.id },
      data: {
        deletedAt: new Date(),
        attendantDeviceId: null,
        bridgeDeviceId: null,
      },
    });
  }

  /** Public context behind a station QR: enough to show the seller where they are. */
  async publicContext(swapId: string, stationId: string) {
    const swap = await this.prisma.skiSwap.findFirst({
      where: { id: swapId, active: true },
      include: { org: true },
    });
    if (!swap) throw new NotFoundException('This swap is not currently running');

    const station = await this.prisma.checkinStation.findFirst({
      where: { id: stationId, orgId: swap.orgId, deletedAt: null },
    });
    if (!station) throw new NotFoundException('Station not found');

    return {
      orgId: swap.orgId,
      orgName: swap.org.name,
      orgLogoUrl: swap.org.logoUrl,
      swapId: swap.id,
      swapTitle: swap.title,
      stationId: station.id,
      stationName: station.name,
    };
  }

  // ─── Guards ────────────────────────────────────────────────────────────────

  /** A device serves one station, in the slot its role decides. */
  private async assertDeviceFree(
    orgId: string,
    deviceId: string,
    expectedRole: DeviceRole,
    stationId: string,
  ): Promise<void> {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, orgId },
      include: { attendedStation: true, bridgedStation: true },
    });
    if (!device) throw new NotFoundException('Device not found');
    if (device.role !== expectedRole) {
      throw new BadRequestException(`That slot takes a "${expectedRole}" device`);
    }

    const held = device.attendedStation ?? device.bridgedStation;
    if (held && held.id !== stationId && !held.deletedAt) {
      throw new ConflictException(
        `That device already serves station "${held.name}". Release it there first.`,
      );
    }
  }

  private async find(orgId: string, stationId: string) {
    const station = await this.prisma.checkinStation.findFirst({
      where: { id: stationId, orgId, deletedAt: null },
    });
    if (!station) throw new NotFoundException('Station not found');
    return station;
  }
}

function toResponse(s: StationRow): StationResponse {
  return {
    id: s.id,
    name: s.name,
    code: s.code,
    // Derived, never stored: a tablet at the counter is what makes it staffed,
    // and a stored flag could disagree with the hardware bound to it.
    kind: s.attendantDeviceId ? 'staffed' : 'self_service',
    attendantDeviceId: s.attendantDeviceId,
    attendantName: s.attendant?.name ?? null,
    attendantLastSeenAt: s.attendant?.lastSeenAt?.toISOString() ?? null,
    bridgeDeviceId: s.bridgeDeviceId,
    bridgeName: s.bridge?.bridgedPrinter?.name ?? null,
    bridgeLastSeenAt: s.bridge?.lastSeenAt?.toISOString() ?? null,
    printerId: s.bridge?.bridgedPrinter?.id ?? null,
    printerName: s.bridge?.bridgedPrinter?.name ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}
