import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import { createId } from '@paralleldrive/cuid2';
import type { SwapPrinterResponse } from '../contracts/ski-swap.contracts';
import { SELLER_NAME_INCLUDE, sellerDisplayName, type SellerNameRow } from './seller.service';

@Injectable()
export class PrinterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
  ) {}

  async list(orgId: string, userId?: string): Promise<SwapPrinterResponse[]> {
    let isAdmin = !userId;
    if (userId) {
      const perms = await this.permissionsService.getPermissions(userId, orgId);
      isAdmin = perms.includes('ski_swap:admin');
    }

    const printers = await this.prisma.swapPrinter.findMany({
      where: isAdmin ? { orgId } : { orgId, assignedSellerId: null },
      include: { seller: { include: SELLER_NAME_INCLUDE } },
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
      include: { seller: { include: SELLER_NAME_INCLUDE } },
      orderBy: { createdAt: 'asc' },
    });
    return printers.map((p) => this.toResponse(p));
  }

  async create(orgId: string, userId: string, data: { name: string; bluetoothName: string; paperSize: string }): Promise<SwapPrinterResponse> {
    const duplicate = await this.prisma.swapPrinter.findFirst({ where: { orgId, bluetoothName: data.bluetoothName } });
    if (duplicate) throw new ConflictException(`"${data.bluetoothName}" is already provisioned as "${duplicate.name}"`);

    const printer = await this.prisma.swapPrinter.create({
      data: { id: createId(), orgId, name: data.name, bluetoothName: data.bluetoothName, paperSize: data.paperSize, createdBy: userId },
      include: { seller: { include: SELLER_NAME_INCLUDE } },
    });
    return this.toResponse(printer);
  }

  async patch(orgId: string, printerId: string, data: { name?: string; bluetoothName?: string; assignedSellerId?: string | null; paperSize?: string; marginTop?: number; marginBottom?: number; marginLeft?: number; marginRight?: number }): Promise<SwapPrinterResponse> {
    const existing = await this.prisma.swapPrinter.findFirst({ where: { id: printerId, orgId } });
    if (!existing) throw new NotFoundException('Printer not found');

    if (data.assignedSellerId) {
      const seller = await this.prisma.sellerProfile.findFirst({
        where: { id: data.assignedSellerId, deletedAt: null, membership: { orgId } },
      });
      if (!seller) throw new NotFoundException('Seller not found');
    }

    const updated = await this.prisma.swapPrinter.update({
      where: { id: printerId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.bluetoothName !== undefined ? { bluetoothName: data.bluetoothName } : {}),
        ...(data.assignedSellerId !== undefined ? { assignedSellerId: data.assignedSellerId } : {}),
        ...(data.paperSize !== undefined ? { paperSize: data.paperSize } : {}),
        ...(data.marginTop !== undefined ? { marginTop: data.marginTop } : {}),
        ...(data.marginBottom !== undefined ? { marginBottom: data.marginBottom } : {}),
        ...(data.marginLeft !== undefined ? { marginLeft: data.marginLeft } : {}),
        ...(data.marginRight !== undefined ? { marginRight: data.marginRight } : {}),
      },
      include: { seller: { include: SELLER_NAME_INCLUDE } },
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
      include: { seller: { include: SELLER_NAME_INCLUDE } },
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
      data: { paperSize },
      include: { seller: { include: SELLER_NAME_INCLUDE } },
    });
    return this.toResponse(updated);
  }

  private toResponse(p: { id: string; name: string; bluetoothName: string; paperSize: string; marginTop: number; marginBottom: number; marginLeft: number; marginRight: number; assignedSellerId: string | null; seller: SellerNameRow | null }): SwapPrinterResponse {
    return {
      id: p.id,
      name: p.name,
      bluetoothName: p.bluetoothName,
      paperSize: p.paperSize as SwapPrinterResponse['paperSize'],
      marginTop: p.marginTop,
      marginBottom: p.marginBottom,
      marginLeft: p.marginLeft,
      marginRight: p.marginRight,
      assignedSellerId: p.assignedSellerId,
      assignedSellerName: sellerDisplayName(p.seller),
    };
  }
}
