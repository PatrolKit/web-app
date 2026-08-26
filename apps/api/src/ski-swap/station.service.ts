import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { SkuService } from './sku.service';

const ADAPTER_ROLE = 'Ski Swap - Network Printer Adapter';

export interface StationResponse {
  id: string;
  name: string;
  code: string;
  deviceId: string | null;
  deviceName: string | null;
  deviceLastSeenAt: string | null;
  printerId: string | null;
  printerName: string | null;
  createdAt: string;
}

const INCLUDE = { device: true, printer: true } as const;

/**
 * Check-in stations: a QR code, a bridge, and a printer.
 *
 * The station is the layer that survives replacing either piece of hardware
 * beneath it, which is why it owns the code that namespaces every SKU printed
 * here — held on the bridge, a dead ESP-32 would change it mid-swap.
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
   * Renames a station, or points it at a different bridge or printer.
   *
   * Re-binding has to be possible because hardware dies mid-swap. Queued jobs
   * survive it: they belong to the station, not to the box underneath.
   */
  async update(
    orgId: string,
    stationId: string,
    data: { name?: string; deviceId?: string | null; printerId?: string | null },
  ): Promise<StationResponse> {
    const station = await this.find(orgId, stationId);

    if (data.deviceId) {
      const device = await this.prisma.device.findFirst({
        where: { id: data.deviceId, orgId },
        include: { checkinStation: true },
      });
      if (!device) throw new NotFoundException('Device not found');
      if (device.role !== ADAPTER_ROLE) {
        throw new BadRequestException(`A station's bridge must be a "${ADAPTER_ROLE}" device`);
      }
      if (device.checkinStation && device.checkinStation.id !== station.id) {
        throw new ConflictException(
          `That bridge already serves station "${device.checkinStation.name}". Release it there first.`,
        );
      }
    }

    if (data.printerId) {
      const printer = await this.prisma.swapPrinter.findFirst({
        where: { id: data.printerId, orgId },
      });
      if (!printer) throw new NotFoundException('Printer not found');
    }

    const updated = await this.prisma.checkinStation.update({
      where: { id: station.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.deviceId !== undefined ? { deviceId: data.deviceId } : {}),
        ...(data.printerId !== undefined ? { printerId: data.printerId } : {}),
      },
      include: INCLUDE,
    });
    return toResponse(updated);
  }

  /** Soft delete — the code stays claimed until it is, so SKUs never collide. */
  async remove(orgId: string, stationId: string): Promise<void> {
    const station = await this.find(orgId, stationId);
    await this.prisma.checkinStation.update({
      where: { id: station.id },
      data: { deletedAt: new Date(), deviceId: null },
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

  private async find(orgId: string, stationId: string) {
    const station = await this.prisma.checkinStation.findFirst({
      where: { id: stationId, orgId, deletedAt: null },
    });
    if (!station) throw new NotFoundException('Station not found');
    return station;
  }
}

function toResponse(s: {
  id: string; name: string; code: string; createdAt: Date;
  deviceId: string | null; printerId: string | null;
  device: { name: string; lastSeenAt: Date | null } | null;
  printer: { name: string } | null;
}): StationResponse {
  return {
    id: s.id,
    name: s.name,
    code: s.code,
    deviceId: s.deviceId,
    deviceName: s.device?.name ?? null,
    deviceLastSeenAt: s.device?.lastSeenAt?.toISOString() ?? null,
    printerId: s.printerId,
    printerName: s.printer?.name ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}
