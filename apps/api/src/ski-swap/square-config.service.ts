import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialCryptoService } from '../common/services/credential-crypto.service';
import { SquareClientService } from './square-client.service';
import { createId } from '@paralleldrive/cuid2';
import type { SquareConfigResponse } from '../contracts/ski-swap.contracts';

@Injectable()
export class SquareConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CredentialCryptoService,
    private readonly squareClient: SquareClientService,
  ) {}

  async exists(orgId: string): Promise<boolean> {
    const count = await this.prisma.squareConfig.count({ where: { orgId } });
    return count > 0;
  }

  async resetOrgData(orgId: string): Promise<{ deletedItems: number; deletedSellers: number }> {
    const [deletedItems, deletedSellers] = await this.prisma.$transaction([
      this.prisma.swapItem.deleteMany({ where: { orgId } }),
      this.prisma.sellerProfile.deleteMany({ where: { membership: { orgId } } }),
    ]);
    // Reset every minting endpoint's counter so numbering starts fresh.
    await this.prisma.swapSkuCounter.deleteMany({ where: { swap: { orgId } } });
    return { deletedItems: deletedItems.count, deletedSellers: deletedSellers.count };
  }

  async get(orgId: string): Promise<SquareConfigResponse> {
    const config = await this.prisma.squareConfig.findUnique({ where: { orgId } });
    if (!config) throw new NotFoundException('Square configuration not found');
    return this.toResponse(config);
  }

  async upsert(
    orgId: string,
    data: { accessToken: string; environment: 'sandbox' | 'production' },
    actorId: string,
    ipAddress?: string,
  ): Promise<SquareConfigResponse> {
    const accessTokenEnc = this.crypto.encrypt(data.accessToken);
    const config = await this.prisma.squareConfig.upsert({
      where: { orgId },
      update: { accessTokenEnc, environment: data.environment },
      create: { id: createId(), orgId, accessTokenEnc, environment: data.environment },
    });
    await this.prisma.auditLog.create({
      data: {
        actorType: 'user',
        actorId,
        orgId,
        action: 'square_config.updated',
        ipAddress: ipAddress ?? null,
      },
    });
    return this.toResponse(config);
  }

  async remove(orgId: string, actorId: string, ipAddress?: string): Promise<void> {
    const existing = await this.prisma.squareConfig.findUnique({ where: { orgId } });
    if (!existing) throw new NotFoundException('Square configuration not found');
    await this.prisma.squareConfig.delete({ where: { orgId } });
    await this.prisma.auditLog.create({
      data: {
        actorType: 'user',
        actorId,
        orgId,
        action: 'square_config.deleted',
        ipAddress: ipAddress ?? null,
      },
    });
  }

  async listLocations(orgId: string): Promise<{ locations: { id: string; name: string }[] }> {
    const client = await this.squareClient.forOrg(orgId);
    try {
      const res = await client.locations.list();
      const locations = (res.locations ?? [])
        .filter((l) => l.status === 'ACTIVE')
        .map((l) => ({ id: l.id ?? '', name: l.name ?? l.id ?? '' }));
      return { locations };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid token';
      throw new BadRequestException(`Could not fetch locations: ${message}`);
    }
  }

  async testConnection(orgId: string): Promise<{ success: boolean; message: string }> {
    const client = await this.squareClient.forOrg(orgId);
    try {
      // Lightweight read — fetches the first page to verify the token is valid
      await client.catalog.list({ types: 'ITEM' });
      return { success: true, message: 'Connection successful' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, message };
    }
  }

  private toResponse(config: {
    orgId: string;
    environment: string;
    updatedAt: Date;
  }): SquareConfigResponse {
    return {
      orgId: config.orgId,
      accessToken: '***',
      environment: config.environment as 'sandbox' | 'production',
      updatedAt: config.updatedAt.toISOString(),
    };
  }
}
