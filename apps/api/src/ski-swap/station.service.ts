import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { SkuService } from './sku.service';
import type { DeviceRole } from '../contracts/devices.contracts';
import type { StationResponse } from '../contracts/ski-swap.contracts';
import { BRIDGED_STATIONS_SELECT } from './bridge-stations.util';
import { LABEL_SIZE, isPaperSize } from './printing/geometry';

/** Which slot a device occupies is decided by what kind of device it is. */
const ATTENDANT_ROLE: DeviceRole = 'ski_swap.staff_check_in';
const BRIDGE_ROLE: DeviceRole = 'ski_swap.print_bridge';

// The printer hangs off the bridge: a station reaches it through the box that
// drives it, so there is one place recording which printer is where.
const INCLUDE = {
  attendant: true,
  bridge: { include: { bridgedPrinter: true, bridgedStations: BRIDGED_STATIONS_SELECT } },
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
    bridgedPrinter: { id: string; name: string; paperSize: string } | null;
    bridgedStations: { id: string; name: string }[];
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
    // Two stations added at once can be handed the same letter; the unique
    // index on live letters refuses the second, which then takes the next.
    for (let attempt = 0; ; attempt++) {
      const code = await this.skuService.allocateCode(orgId);
      try {
        const station = await this.prisma.checkinStation.create({
          data: { id: createId(), orgId, name, code, liveCode: code },
          include: INCLUDE,
        });
        return toResponse(station);
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002' || attempt >= 2) throw err;
      }
    }
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
      await this.assertAttendantFree(orgId, data.attendantDeviceId, station.id);
    }

    // Staffed is having an attendant, so this is what the station will be once
    // the patch lands — the sharing rule is about that, not about now.
    const willBeStaffed =
      data.attendantDeviceId !== undefined ? !!data.attendantDeviceId : !!station.attendantDeviceId;
    const bridgeId = data.bridgeDeviceId !== undefined ? data.bridgeDeviceId : station.bridgeDeviceId;
    if (bridgeId && (data.bridgeDeviceId || !willBeStaffed)) {
      await this.assertBridgeShareable(orgId, bridgeId, station.id, station.name, willBeStaffed);
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
   * Soft delete. The code stays on the row; `allocateCode` decides when it can
   * be given out again.
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
        // Its letter stays on the row as history, but is no longer held: it
        // can go to a new station once no running swap has tags under it.
        liveCode: null,
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

  /** A tablet serves one station. */
  private async assertAttendantFree(orgId: string, deviceId: string, stationId: string): Promise<void> {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, orgId },
      include: { attendedStation: true },
    });
    if (!device) throw new NotFoundException('Device not found');
    if (device.role !== ATTENDANT_ROLE) {
      throw new BadRequestException(`That slot takes a "${ATTENDANT_ROLE}" device`);
    }
    const held = device.attendedStation;
    if (held && held.id !== stationId && !held.deletedAt) {
      throw new ConflictException(
        `That device already serves station "${held.name}". Release it there first.`,
      );
    }
  }

  /**
   * Whether this station may print through this bridge (Plan 27).
   *
   * A bridge serves either one self-service station or any number of staffed
   * ones, never a mix. A self-service seller is standing at the QR code with
   * nobody to fetch tags from anywhere else, so their tags must come out where
   * they are; a staffed counter has somebody who can walk to a shared printer.
   *
   * Checked when a bridge is bound, and when a station sharing one is about to
   * stop being staffed — which would otherwise make it a self-service station
   * printing somewhere else.
   */
  private async assertBridgeShareable(
    orgId: string,
    deviceId: string,
    stationId: string,
    stationName: string,
    willBeStaffed: boolean,
  ): Promise<void> {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, orgId },
      include: { bridgedStations: { where: { deletedAt: null, id: { not: stationId } } } },
    });
    if (!device) throw new NotFoundException('Device not found');
    if (device.role !== BRIDGE_ROLE) {
      throw new BadRequestException(`That slot takes a "${BRIDGE_ROLE}" device`);
    }

    const others = device.bridgedStations;
    if (others.length === 0) return;
    const names = listOf(others.map((o) => o.name));

    if (!willBeStaffed) {
      throw new ConflictException(
        `"${stationName}" would be a self-service station sharing its bridge with ${names}. ` +
          'A self-service station keeps its bridge to itself: give it its own bridge, or keep a tablet at it.',
      );
    }
    const selfService = others.find((o) => !o.attendantDeviceId);
    if (selfService) {
      throw new ConflictException(
        `That bridge serves the self-service station "${selfService.name}". ` +
          'A self-service station keeps its bridge to itself.',
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
    // The other stations printing through the same bridge, so the list can say
    // "also serves Station 1" rather than leave staff to work it out.
    bridgeSharedWith: (s.bridge?.bridgedStations ?? [])
      .filter((o) => o.id !== s.id)
      .map((o) => o.name),
    helperLabelsOnly: helperOnlyStock(s.bridge?.bridgedPrinter?.paperSize),
    createdAt: s.createdAt.toISOString(),
  };
}

/** A printer loaded with 25 × 67 prints legacy helper labels and nothing else (Plan 28). */
function helperOnlyStock(paperSize: string | undefined): boolean {
  return !!paperSize && isPaperSize(paperSize) && LABEL_SIZE[paperSize].tier === 'strip';
}

/** "A", "A and B", "A, B and C". */
function listOf(names: string[]): string {
  const quoted = names.map((n) => `"${n}"`);
  return quoted.length <= 1 ? (quoted[0] ?? '') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}
