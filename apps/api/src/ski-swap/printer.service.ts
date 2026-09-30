import { BRIDGED_STATIONS_SELECT, bridgedStationNames } from './bridge-stations.util';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import { createId } from '@paralleldrive/cuid2';
import { LABEL_SIZE, type PaperSize } from './printing/geometry';
import type { SwapPrinterResponse } from '../contracts/ski-swap.contracts';
import { SELLER_NAME_INCLUDE, sellerDisplayName, type SellerNameRow } from './seller.service';
import { LegacyTicketService } from './legacy-ticket.service';

@Injectable()
export class PrinterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
    private readonly tickets: LegacyTicketService,
  ) {}

  async list(orgId: string, userId?: string): Promise<SwapPrinterResponse[]> {
    let isAdmin = !userId;
    if (userId) {
      const perms = await this.permissionsService.getPermissions(userId, orgId);
      isAdmin = perms.includes('ski_swap:admin');
    }

    const printers = await this.prisma.swapPrinter.findMany({
      where: isAdmin ? { orgId } : { orgId, assignedSellerId: null },
      include: { seller: { include: SELLER_NAME_INCLUDE }, bridge: { include: { bridgedStations: BRIDGED_STATIONS_SELECT } } },
      orderBy: { createdAt: 'asc' },
    });
    return printers.map((p) => this.toResponse(p));
  }

  async listForSeller(orgId: string, userId: string): Promise<SwapPrinterResponse[]> {
    const seller = await this.prisma.sellerProfile.findFirst({
      where: { deletedAt: null, membership: { orgId, userId, deletedAt: null } },
    });
    if (!seller) return [];

    const printers = await this.prisma.swapPrinter.findMany({
      where: { orgId, assignedSellerId: seller.id },
      include: { seller: { include: SELLER_NAME_INCLUDE }, bridge: { include: { bridgedStations: BRIDGED_STATIONS_SELECT } } },
      orderBy: { createdAt: 'asc' },
    });
    return printers.map((p) => this.toResponse(p));
  }

  async create(orgId: string, userId: string, data: { name: string; bluetoothName: string; model: string; paperSize: string }): Promise<SwapPrinterResponse> {
    const duplicate = await this.prisma.swapPrinter.findFirst({ where: { orgId, bluetoothName: data.bluetoothName } });
    if (duplicate) throw new ConflictException(`"${data.bluetoothName}" is already provisioned as "${duplicate.name}"`);

    const printer = await this.prisma.swapPrinter.create({
      data: {
        id: createId(), orgId, name: data.name, bluetoothName: data.bluetoothName,
        model: data.model, paperSize: data.paperSize,
        // The safety inset starts from the stock, not from a global default: 4
        // dots is a sensible fraction of a 30 mm label and nearly nothing on a
        // 100 mm one.
        ...LABEL_SIZE[data.paperSize as PaperSize].defaultMargins,
        createdBy: userId,
      },
      include: { seller: { include: SELLER_NAME_INCLUDE }, bridge: { include: { bridgedStations: BRIDGED_STATIONS_SELECT } } },
    });
    return this.toResponse(printer);
  }

  /**
   * A printer serves exactly one thing: one bridge, or one business seller.
   *
   * It is a single BLE peripheral and whoever holds the link owns it. A bridge
   * holds that link continuously, so a printer shared with a seller means the
   * bridge wins and the seller's printing stops with nothing on screen to say
   * why. The unique index covers bridge-to-bridge; this covers the rest.
   */
  private async assertBridgeAssignable(orgId: string, bridgeDeviceId: string, printerId: string): Promise<void> {
    const bridge = await this.prisma.device.findFirst({
      where: { id: bridgeDeviceId, orgId },
      include: { bridgedPrinter: true },
    });
    if (!bridge) throw new NotFoundException('Bridge not found');
    if (bridge.role !== 'ski_swap.print_bridge') {
      throw new BadRequestException('Only a print bridge can drive a printer');
    }
    if (bridge.bridgedPrinter && bridge.bridgedPrinter.id !== printerId) {
      throw new ConflictException(
        `That bridge already drives "${bridge.bridgedPrinter.name}". Release it there first.`,
      );
    }
  }

  async patch(orgId: string, printerId: string, data: { name?: string; bluetoothName?: string; assignedSellerId?: string | null; bridgeDeviceId?: string | null; model?: string; paperSize?: string; marginTop?: number; marginBottom?: number; marginLeft?: number; marginRight?: number }): Promise<SwapPrinterResponse> {
    const existing = await this.prisma.swapPrinter.findFirst({
      where: { id: printerId, orgId },
      include: { bridge: { include: { bridgedStations: BRIDGED_STATIONS_SELECT } } },
    });
    if (!existing) throw new NotFoundException('Printer not found');

    if (data.assignedSellerId) {
      const seller = await this.prisma.sellerProfile.findFirst({
        where: { id: data.assignedSellerId, deletedAt: null, membership: { orgId } },
      });
      if (!seller) throw new NotFoundException('Seller not found');

      // The other half of "a printer serves exactly one thing". A printer driven
      // by a bridge is held by that bridge continuously; handing it to a seller
      // as well means the bridge wins and the seller's printing stops with
      // nothing on screen to say why.
      if (existing.bridgeDeviceId) {
        throw new ConflictException(
          `That printer is driven by "${existing.bridge?.name ?? 'a bridge'}". Release it there before assigning it to a seller.`,
        );
      }

      // A printer and issued tickets are alternative answers to "how does this
      // item get a tag". A seller holding both would have two SKUs competing
      // for one item, so the exclusivity is enforced from both directions.
      await this.tickets.assertNoRanges(orgId, data.assignedSellerId);
    }

    if (data.bridgeDeviceId) {
      if (existing.assignedSellerId || data.assignedSellerId) {
        throw new ConflictException(
          'That printer is assigned to a business seller. Unassign it before giving it to a bridge.',
        );
      }
      await this.assertBridgeAssignable(orgId, data.bridgeDeviceId, printerId);
    }

    const updated = await this.prisma.swapPrinter.update({
      where: { id: printerId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.bluetoothName !== undefined ? { bluetoothName: data.bluetoothName } : {}),
        ...(data.assignedSellerId !== undefined ? { assignedSellerId: data.assignedSellerId } : {}),
        ...(data.bridgeDeviceId !== undefined ? { bridgeDeviceId: data.bridgeDeviceId } : {}),
        ...(data.model !== undefined ? { model: data.model } : {}),
        // A size change resets the inset: the old numbers were chosen against a
        // different label, and on a bigger one they are no longer a margin.
        ...(data.paperSize !== undefined
          ? { paperSize: data.paperSize, ...LABEL_SIZE[data.paperSize as PaperSize].defaultMargins }
          : {}),
        ...(data.marginTop !== undefined ? { marginTop: data.marginTop } : {}),
        ...(data.marginBottom !== undefined ? { marginBottom: data.marginBottom } : {}),
        ...(data.marginLeft !== undefined ? { marginLeft: data.marginLeft } : {}),
        ...(data.marginRight !== undefined ? { marginRight: data.marginRight } : {}),
      },
      include: { seller: { include: SELLER_NAME_INCLUDE }, bridge: { include: { bridgedStations: BRIDGED_STATIONS_SELECT } } },
    });
    return this.toResponse(updated);
  }

  async remove(orgId: string, printerId: string): Promise<void> {
    const existing = await this.prisma.swapPrinter.findFirst({ where: { id: printerId, orgId } });
    if (!existing) throw new NotFoundException('Printer not found');
    await this.prisma.swapPrinter.delete({ where: { id: printerId } });
  }

  /**
   * Who may drive a given printer: admins any of them, staff the org pool, and a
   * business seller only the one assigned to them. Anything that acts on a
   * printer someone is physically standing at goes through here, so paper size
   * and label rendering cannot disagree about who owns the hardware.
   */
  async assertPrinterAccess(orgId: string, printerId: string, userId: string) {
    const perms = await this.permissionsService.getPermissions(userId, orgId);
    const isAdmin = perms.includes('ski_swap:admin');
    const isManage = perms.includes('ski_swap:manage');
    const isSeller = perms.includes('business_seller');
    if (!isAdmin && !isManage && !isSeller) throw new ForbiddenException();

    const printer = await this.prisma.swapPrinter.findFirst({
      where: { id: printerId, orgId },
      include: { seller: { include: SELLER_NAME_INCLUDE }, bridge: { include: { bridgedStations: BRIDGED_STATIONS_SELECT } } },
    });
    if (!printer) throw new NotFoundException('Printer not found');

    if (!isAdmin) {
      if (isManage && printer.assignedSellerId !== null) throw new ForbiddenException('Not your printer');
      if (isSeller && !isManage) {
        const sellerRecord = await this.prisma.sellerProfile.findFirst({
          where: { deletedAt: null, membership: { orgId, userId, deletedAt: null } },
        });
        if (!sellerRecord || printer.assignedSellerId !== sellerRecord.id) throw new ForbiddenException('Not your printer');
      }
    }
    return printer;
  }

  async patchPaperSize(orgId: string, printerId: string, paperSize: string, userId: string): Promise<SwapPrinterResponse> {
    await this.assertPrinterAccess(orgId, printerId, userId);

    const updated = await this.prisma.swapPrinter.update({
      where: { id: printerId },
      data: { paperSize, ...LABEL_SIZE[paperSize as PaperSize].defaultMargins },
      include: { seller: { include: SELLER_NAME_INCLUDE }, bridge: { include: { bridgedStations: BRIDGED_STATIONS_SELECT } } },
    });
    return this.toResponse(updated);
  }

  private toResponse(p: { id: string; name: string; bluetoothName: string; model: string; paperSize: string; marginTop: number; marginBottom: number; marginLeft: number; marginRight: number; assignedSellerId: string | null; seller: SellerNameRow | null; bridgeDeviceId?: string | null; bridge?: { bridgedStations?: { name: string }[] } | null }): SwapPrinterResponse {
    return {
      id: p.id,
      name: p.name,
      bluetoothName: p.bluetoothName,
      model: p.model as SwapPrinterResponse['model'],
      paperSize: p.paperSize as SwapPrinterResponse['paperSize'],
      marginTop: p.marginTop,
      marginBottom: p.marginBottom,
      marginLeft: p.marginLeft,
      marginRight: p.marginRight,
      assignedSellerId: p.assignedSellerId,
      assignedSellerName: sellerDisplayName(p.seller),
      bridgeDeviceId: p.bridgeDeviceId ?? null,
      // Which counters this printer ends up serving, reached the way the queue
      // reaches it: station → bridge → printer. Several, when the bridge is
      // shared by staffed stations (Plan 27).
      ...bridgedStationNames(p.bridge?.bridgedStations),
    };
  }
}
