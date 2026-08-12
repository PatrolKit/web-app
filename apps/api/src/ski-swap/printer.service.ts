import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import { createId } from '@paralleldrive/cuid2';
import type { SwapPrinterResponse } from '../contracts/ski-swap.contracts';

@Injectable()
export class PrinterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
  ) {}

  async list(orgId: string, userId: string): Promise<SwapPrinterResponse[]> {
    const perms = await this.permissionsService.getPermissions(userId, orgId);
    const isAdmin = perms.includes('ski_swap:admin');

    const printers = await this.prisma.swapPrinter.findMany({
      where: isAdmin ? { orgId } : { orgId, assignedSellerId: null },
      include: { seller: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return printers.map((p) => this.toResponse(p));
  }

  async listForSeller(orgId: string, userId: string): Promise<SwapPrinterResponse[]> {
    const seller = await this.prisma.swapSeller.findFirst({ where: { orgId, userId } });
    if (!seller) return [];

    const printers = await this.prisma.swapPrinter.findMany({
      where: { orgId, assignedSellerId: seller.id },
      include: { seller: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return printers.map((p) => this.toResponse(p));
  }

  async create(orgId: string, userId: string, data: { name: string; bluetoothName: string; paperSize: string }): Promise<SwapPrinterResponse> {
    const duplicate = await this.prisma.swapPrinter.findFirst({ where: { orgId, bluetoothName: data.bluetoothName } });
    if (duplicate) throw new ConflictException(`"${data.bluetoothName}" is already provisioned as "${duplicate.name}"`);

    const printer = await this.prisma.swapPrinter.create({
      data: { id: createId(), orgId, name: data.name, bluetoothName: data.bluetoothName, paperSize: data.paperSize, createdBy: userId },
      include: { seller: { select: { name: true } } },
    });
    return this.toResponse(printer);
  }

  async patch(orgId: string, printerId: string, data: { name?: string; bluetoothName?: string; assignedSellerId?: string | null; paperSize?: string; marginTop?: number; marginBottom?: number; marginLeft?: number; marginRight?: number }): Promise<SwapPrinterResponse> {
    const existing = await this.prisma.swapPrinter.findFirst({ where: { id: printerId, orgId } });
    if (!existing) throw new NotFoundException('Printer not found');

    if (data.assignedSellerId) {
      const seller = await this.prisma.swapSeller.findFirst({ where: { id: data.assignedSellerId, orgId } });
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
      include: { seller: { select: { name: true } } },
    });
    return this.toResponse(updated);
  }

  async remove(orgId: string, printerId: string): Promise<void> {
    const existing = await this.prisma.swapPrinter.findFirst({ where: { id: printerId, orgId } });
    if (!existing) throw new NotFoundException('Printer not found');
    await this.prisma.swapPrinter.delete({ where: { id: printerId } });
  }

  async patchPaperSize(orgId: string, printerId: string, paperSize: string, userId: string): Promise<SwapPrinterResponse> {
    const perms = await this.permissionsService.getPermissions(userId, orgId);
    const isAdmin = perms.includes('ski_swap:admin');
    const isManage = perms.includes('ski_swap:manage');
    const isSeller = perms.includes('business_seller');
    if (!isAdmin && !isManage && !isSeller) throw new ForbiddenException();

    const printer = await this.prisma.swapPrinter.findFirst({
      where: { id: printerId, orgId },
      include: { seller: { select: { name: true } } },
    });
    if (!printer) throw new NotFoundException('Printer not found');

    // Validate access: manage users own org-pool printers; sellers own their assigned printer
    if (!isAdmin) {
      if (isManage && printer.assignedSellerId !== null) throw new ForbiddenException('Not your printer');
      if (isSeller && !isManage) {
        const sellerRecord = await this.prisma.swapSeller.findFirst({ where: { orgId, userId } });
        if (!sellerRecord || printer.assignedSellerId !== sellerRecord.id) throw new ForbiddenException('Not your printer');
      }
    }

    const updated = await this.prisma.swapPrinter.update({
      where: { id: printerId },
      data: { paperSize },
      include: { seller: { select: { name: true } } },
    });
    return this.toResponse(updated);
  }

  private toResponse(p: { id: string; name: string; bluetoothName: string; paperSize: string; marginTop: number; marginBottom: number; marginLeft: number; marginRight: number; assignedSellerId: string | null; seller: { name: string } | null }): SwapPrinterResponse {
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
      assignedSellerName: p.seller?.name ?? null,
    };
  }
}
