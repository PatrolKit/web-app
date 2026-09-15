import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import type { SwapScannerResponse } from '../contracts/ski-swap.contracts';

const SCANNER_INCLUDE = {
  bridge: { include: { bridgedStation: true } },
} as const;

type ScannerRow = {
  id: string;
  name: string;
  bluetoothName: string;
  bridgeDeviceId: string | null;
  bridge: { bridgedStation: { name: string } | null } | null;
};

/**
 * The barcode scanners an org owns, and which bridge drives each.
 *
 * Deliberately a near-copy of `PrinterService` rather than a shared abstraction.
 * The two have three columns in common and nothing else: a printer carries paper
 * and margins and can be handed to a business seller, a scanner carries none of
 * that and never leaves staff hands. Folding them together would mean nullable
 * printer columns on every scanner and a `kind` to branch on in the one place —
 * the print queue — that currently cannot be wrong about what it resolved.
 */
@Injectable()
export class ScannerService {
  constructor(private readonly prisma: PrismaService) {}

  async list(orgId: string): Promise<SwapScannerResponse[]> {
    const scanners = await this.prisma.swapScanner.findMany({
      where: { orgId },
      include: SCANNER_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return scanners.map((s) => this.toResponse(s));
  }

  async create(
    orgId: string,
    userId: string,
    data: { name: string; bluetoothName: string },
  ): Promise<SwapScannerResponse> {
    // Provisioning the same peripheral twice gives two records fighting for one
    // link, and the second one silently never works.
    const duplicate = await this.prisma.swapScanner.findFirst({
      where: { orgId, bluetoothName: data.bluetoothName },
    });
    if (duplicate) {
      throw new ConflictException(
        `"${data.bluetoothName}" is already provisioned as "${duplicate.name}"`,
      );
    }

    const scanner = await this.prisma.swapScanner.create({
      data: {
        id: createId(), orgId,
        name: data.name, bluetoothName: data.bluetoothName,
        createdBy: userId,
      },
      include: SCANNER_INCLUDE,
    });
    return this.toResponse(scanner);
  }

  async patch(
    orgId: string,
    scannerId: string,
    data: { name?: string; bluetoothName?: string; bridgeDeviceId?: string | null },
  ): Promise<SwapScannerResponse> {
    const existing = await this.prisma.swapScanner.findFirst({ where: { id: scannerId, orgId } });
    if (!existing) throw new NotFoundException('Scanner not found');

    if (data.bluetoothName && data.bluetoothName !== existing.bluetoothName) {
      const duplicate = await this.prisma.swapScanner.findFirst({
        where: { orgId, bluetoothName: data.bluetoothName, id: { not: scannerId } },
      });
      if (duplicate) {
        throw new ConflictException(
          `"${data.bluetoothName}" is already provisioned as "${duplicate.name}"`,
        );
      }
    }

    if (data.bridgeDeviceId) {
      await this.assertBridgeAssignable(orgId, data.bridgeDeviceId, scannerId);
    }

    const updated = await this.prisma.swapScanner.update({
      where: { id: scannerId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.bluetoothName !== undefined ? { bluetoothName: data.bluetoothName } : {}),
        ...(data.bridgeDeviceId !== undefined ? { bridgeDeviceId: data.bridgeDeviceId } : {}),
      },
      include: SCANNER_INCLUDE,
    });
    return this.toResponse(updated);
  }

  async remove(orgId: string, scannerId: string): Promise<void> {
    const scanner = await this.prisma.swapScanner.findFirst({ where: { id: scannerId, orgId } });
    if (!scanner) throw new NotFoundException('Scanner not found');
    await this.prisma.swapScanner.delete({ where: { id: scannerId } });
  }

  /**
   * A scanner is driven by one bridge, and only by a print bridge.
   *
   * The unique index already stops two scanners naming one bridge; this is the
   * readable half — it says which scanner is in the way rather than surfacing a
   * constraint violation. A bridge may hold a printer and a scanner at once:
   * they are two peripherals, and holding one link says nothing about the other.
   */
  private async assertBridgeAssignable(
    orgId: string,
    bridgeDeviceId: string,
    scannerId: string,
  ): Promise<void> {
    const bridge = await this.prisma.device.findFirst({
      where: { id: bridgeDeviceId, orgId },
      include: { bridgedScanner: true },
    });
    if (!bridge) throw new NotFoundException('Bridge not found');
    if (bridge.role !== 'ski_swap.print_bridge') {
      throw new BadRequestException('Only a print bridge can drive a scanner');
    }
    if (bridge.bridgedScanner && bridge.bridgedScanner.id !== scannerId) {
      throw new ConflictException(
        `That bridge already drives "${bridge.bridgedScanner.name}". Release it there first.`,
      );
    }
  }

  private toResponse(s: ScannerRow): SwapScannerResponse {
    return {
      id: s.id,
      name: s.name,
      bluetoothName: s.bluetoothName,
      bridgeDeviceId: s.bridgeDeviceId,
      stationName: s.bridge?.bridgedStation?.name ?? null,
    };
  }
}
