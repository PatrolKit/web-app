import { Injectable, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../../prisma/prisma.service';
import { CredentialCryptoService } from '../../common/services/credential-crypto.service';
import { PayPalClient } from './paypal.client';
import type { PayPalConfigResponse } from '../../contracts/payouts.contracts';

/**
 * The org's PayPal credentials (Plan 25 §6).
 *
 * Shaped after SquareConfigService deliberately: one row per org, the secret
 * encrypted at rest, an audit row on every write, and an endpoint that proves
 * the credentials work before a swap depends on them.
 */
@Injectable()
export class PayPalConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CredentialCryptoService,
    private readonly paypal: PayPalClient,
  ) {}

  async exists(orgId: string): Promise<boolean> {
    return (await this.prisma.payPalConfig.count({ where: { orgId } })) > 0;
  }

  async get(orgId: string): Promise<PayPalConfigResponse> {
    const config = await this.prisma.payPalConfig.findUnique({ where: { orgId } });
    if (!config) throw new NotFoundException('PayPal is not configured for this organization');
    return this.toResponse(config);
  }

  /**
   * Whether payouts can be sent at all, for screens that need to explain their
   * own absence rather than simply fail.
   */
  async status(orgId: string): Promise<{ configured: boolean; environment: string | null; webhookRegistered: boolean }> {
    const config = await this.prisma.payPalConfig.findUnique({ where: { orgId } });
    return {
      configured: !!config,
      environment: config?.environment ?? null,
      webhookRegistered: !!config?.webhookId,
    };
  }

  async upsert(
    orgId: string,
    data: {
      clientId: string;
      clientSecret: string;
      environment: 'sandbox' | 'live';
      webhookId?: string | null;
    },
    actorId: string,
    ipAddress?: string,
  ): Promise<PayPalConfigResponse> {
    const clientSecretEnc = this.crypto.encrypt(data.clientSecret);
    const webhookId = data.webhookId ?? null;

    const config = await this.prisma.payPalConfig.upsert({
      where: { orgId },
      update: {
        clientId: data.clientId,
        clientSecretEnc,
        environment: data.environment,
        webhookId,
      },
      create: {
        id: createId(),
        orgId,
        clientId: data.clientId,
        clientSecretEnc,
        environment: data.environment,
        webhookId,
      },
    });

    // The environment is in the audit row because switching an org from
    // sandbox to live is the single most consequential change on this screen,
    // and "who pointed us at real money, and when" should not need a diff of
    // backups to answer.
    await this.prisma.auditLog.create({
      data: {
        actorType: 'user',
        actorId,
        orgId,
        action: 'paypal_config.updated',
        metadata: { environment: data.environment, webhookRegistered: !!webhookId },
        ipAddress: ipAddress ?? null,
      },
    });

    return this.toResponse(config);
  }

  async remove(orgId: string, actorId: string, ipAddress?: string): Promise<void> {
    const existing = await this.prisma.payPalConfig.findUnique({ where: { orgId } });
    if (!existing) throw new NotFoundException('PayPal is not configured for this organization');

    await this.prisma.payPalConfig.delete({ where: { orgId } });
    await this.prisma.auditLog.create({
      data: {
        actorType: 'user',
        actorId,
        orgId,
        action: 'paypal_config.deleted',
        ipAddress: ipAddress ?? null,
      },
    });
  }

  testConnection(orgId: string): Promise<{ success: boolean; message: string }> {
    return this.paypal.testConnection(orgId);
  }

  private toResponse(config: {
    orgId: string;
    clientId: string;
    clientSecretEnc: string;
    environment: string;
    webhookId: string | null;
    updatedAt: Date;
  }): PayPalConfigResponse {
    return {
      orgId: config.orgId,
      clientId: config.clientId,
      environment: config.environment === 'live' ? 'live' : 'sandbox',
      webhookId: config.webhookId,
      hasSecret: config.clientSecretEnc.length > 0,
      updatedAt: config.updatedAt.toISOString(),
    };
  }
}
