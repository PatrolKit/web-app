import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createId } from '@paralleldrive/cuid2';
import type { SellerResponse } from '../contracts/ski-swap.contracts';

/** Strip all non-digit characters for consistent phone storage and lookup. */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

@Injectable()
export class SellerService {
  constructor(private readonly prisma: PrismaService) {}

  async list(orgId: string, query?: string): Promise<SellerResponse[]> {
    const sellers = await this.prisma.swapSeller.findMany({
      where: {
        orgId,
        ...(query
          ? {
              OR: [
                { name: { contains: query } },
                { phone: { contains: query.replace(/\D/g, '') } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
    });
    return sellers.map(this.toResponse);
  }

  async get(orgId: string, sellerId: string): Promise<SellerResponse> {
    const seller = await this.findOrThrow(orgId, sellerId);
    return this.toResponse(seller);
  }

  async create(
    orgId: string,
    data: {
      name: string;
      phone: string;
      email?: string;
      street?: string;
      city?: string;
      state?: string;
      zip?: string;
    },
  ): Promise<SellerResponse> {
    const seller = await this.prisma.swapSeller.create({
      data: {
        id: createId(),
        orgId,
        name: data.name,
        phone: normalizePhone(data.phone),
        email: data.email ?? null,
        street: data.street ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        zip: data.zip ?? null,
      },
    });
    return this.toResponse(seller);
  }

  async patch(
    orgId: string,
    sellerId: string,
    data: {
      name?: string;
      phone?: string;
      email?: string | null;
      street?: string | null;
      city?: string | null;
      state?: string | null;
      zip?: string | null;
    },
  ): Promise<SellerResponse> {
    await this.findOrThrow(orgId, sellerId);
    const seller = await this.prisma.swapSeller.update({
      where: { id: sellerId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.phone !== undefined ? { phone: normalizePhone(data.phone) } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.street !== undefined ? { street: data.street } : {}),
        ...(data.city !== undefined ? { city: data.city } : {}),
        ...(data.state !== undefined ? { state: data.state } : {}),
        ...(data.zip !== undefined ? { zip: data.zip } : {}),
      },
    });
    return this.toResponse(seller);
  }

  async remove(orgId: string, sellerId: string): Promise<void> {
    await this.findOrThrow(orgId, sellerId);
    const itemCount = await this.prisma.swapItemSeller.count({ where: { sellerId } });
    if (itemCount > 0) {
      throw new ConflictException(
        'Cannot delete a seller with active item mappings. Unassign all items first.',
      );
    }
    await this.prisma.swapSeller.delete({ where: { id: sellerId } });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async findOrThrow(orgId: string, sellerId: string) {
    const seller = await this.prisma.swapSeller.findFirst({ where: { id: sellerId, orgId } });
    if (!seller) throw new NotFoundException('Seller not found');
    return seller;
  }

  private toResponse(seller: {
    id: string;
    orgId: string;
    name: string;
    phone: string;
    email: string | null;
    street: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): SellerResponse {
    return {
      id: seller.id,
      orgId: seller.orgId,
      name: seller.name,
      phone: seller.phone,
      email: seller.email,
      street: seller.street,
      city: seller.city,
      state: seller.state,
      zip: seller.zip,
      createdAt: seller.createdAt.toISOString(),
      updatedAt: seller.updatedAt.toISOString(),
    };
  }
}
