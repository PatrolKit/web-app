import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

  async create(orgId: string, userId: string, data: { name: string; bluetoothName: string }): Promise<SwapPrinterResponse> {
    const duplicate = await this.prisma.swapPrinter.findFirst({ where: { orgId, bluetoothName: data.bluetoothName } });
    if (duplicate) throw new ConflictException(`"${data.bluetoothName}" is already provisioned as "${duplicate.name}"`);

    const printer = await this.prisma.swapPrinter.create({
      data: { id: createId(), orgId, name: data.name, bluetoothName: data.bluetoothName, createdBy: userId },
      include: { seller: { select: { name: true } } },
    });
    return this.toResponse(printer);
  }

  async patch(orgId: string, printerId: string, data: { name?: string; bluetoothName?: string; assignedSellerId?: string | null }): Promise<SwapPrinterResponse> {
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

  private toResponse(p: { id: string; name: string; bluetoothName: string; assignedSellerId: string | null; seller: { name: string } | null }): SwapPrinterResponse {
    return {
      id: p.id,
      name: p.name,
      bluetoothName: p.bluetoothName,
      assignedSellerId: p.assignedSellerId,
      assignedSellerName: p.seller?.name ?? null,
    };
  }
}
