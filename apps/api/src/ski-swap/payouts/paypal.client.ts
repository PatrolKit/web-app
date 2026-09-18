import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CredentialCryptoService } from '../../common/services/credential-crypto.service';
import type { Recipient } from './paypal-mapping';

/**
 * Talking to PayPal Payouts (Plan 25 §6).
 *
 * Four calls, written by hand rather than taken from an SDK. There is no
 * maintained Node SDK for Payouts — `@paypal/payouts-sdk` was last published
 * around five years ago, and `@paypal/paypal-server-sdk` covers Checkout and
 * Orders — and adopting somebody's abandoned dependency for four HTTP calls
 * would buy nothing in the one part of the system that moves money.
 */

export interface PayoutItemRequest {
  /** Our `PayoutLine.id`. Echoed back on every status, so no lookup table. */
  senderItemId: string;
  amountCents: number;
  recipient: Recipient;
  /** Required for Venmo, harmless for PayPal, and useful to the seller either way. */
  note: string;
}

export interface PayoutItemStatus {
  senderItemId: string;
  payoutItemId: string;
  /** Raw, as PayPal said it. Mapped by `mapItemStatus`, never here. */
  transactionStatus: string;
  errorMessage?: string;
}

export interface PayoutBatchResult {
  batchId: string;
  batchStatus: string;
  items: PayoutItemStatus[];
}

/**
 * What a payout provider has to be able to do.
 *
 * An interface because tests must never reach the real thing, and because the
 * smoke script counts what arrives here to prove a second send sends nothing.
 */
export abstract class PayPalClient {
  abstract createBatch(
    orgId: string,
    senderBatchId: string,
    items: PayoutItemRequest[],
  ): Promise<PayoutBatchResult>;
  abstract getBatch(orgId: string, batchId: string): Promise<PayoutBatchResult>;
  abstract cancelItem(orgId: string, payoutItemId: string): Promise<void>;
  abstract verifyWebhook(orgId: string, headers: Record<string, string>, rawBody: string): Promise<boolean>;
  abstract testConnection(orgId: string): Promise<{ success: boolean; message: string }>;
}

/**
 * The scope PayPal grants an app that is allowed to pay people.
 *
 * Checked at configuration time rather than discovered at send time, because
 * the failure it prevents is a batch that authenticates, is accepted, and then
 * pays nobody.
 */
const PAYOUTS_SCOPE = 'https://uri.paypal.com/services/payments/payouts';

const HOSTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
} as const;

@Injectable()
export class HttpPayPalClient extends PayPalClient {
  private readonly logger = new Logger(HttpPayPalClient.name);
  /** Short-lived, and re-fetched rather than refreshed. */
  private tokens = new Map<string, { token: string; expiresAt: number; scopes: string[] }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CredentialCryptoService,
  ) {
    super();
  }

  async createBatch(
    orgId: string,
    senderBatchId: string,
    items: PayoutItemRequest[],
  ): Promise<PayoutBatchResult> {
    const body = {
      sender_batch_header: {
        sender_batch_id: senderBatchId,
        email_subject: 'Your ski swap payout',
      },
      items: items.map((i) => ({
        amount: { value: (i.amountCents / 100).toFixed(2), currency: 'USD' },
        sender_item_id: i.senderItemId,
        note: i.note,
        ...i.recipient,
      })),
    };

    const res = await this.call(orgId, 'POST', '/v1/payments/payouts', body);
    return this.toBatchResult(res);
  }

  async getBatch(orgId: string, batchId: string): Promise<PayoutBatchResult> {
    const res = await this.call(orgId, 'GET', `/v1/payments/payouts/${batchId}`);
    return this.toBatchResult(res);
  }

  async cancelItem(orgId: string, payoutItemId: string): Promise<void> {
    await this.call(orgId, 'POST', `/v1/payments/payouts-item/${payoutItemId}/cancel`);
  }

  /**
   * Whether PayPal actually sent this webhook.
   *
   * Never skipped. An unverified payout webhook is an unauthenticated status
   * change on a money record, and anybody can POST to a public URL.
   */
  async verifyWebhook(
    orgId: string,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<boolean> {
    const config = await this.prisma.payPalConfig.findUnique({ where: { orgId } });
    if (!config?.webhookId) {
      this.logger.error({ orgId }, 'No webhook id registered — cannot verify, so refusing');
      return false;
    }

    const res = await this.call(orgId, 'POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: config.webhookId,
      // PayPal re-serialises this, so it must be the parsed body rather than
      // the raw string — the one place their documentation is counter-intuitive.
      webhook_event: JSON.parse(rawBody),
    });
    return (res as { verification_status?: string }).verification_status === 'SUCCESS';
  }

  /**
   * Whether these credentials work, and whether they are allowed to pay people.
   *
   * Two different questions. A client id and secret from an app that was never
   * granted Payouts will fetch a token quite happily and then fail at the only
   * moment that matters, so the granted scopes are read here while somebody is
   * still looking at the settings screen.
   */
  async testConnection(orgId: string): Promise<{ success: boolean; message: string }> {
    try {
      const { scopes, host } = await this.authorise(orgId);
      const where = host.includes('sandbox') ? 'sandbox' : 'live';
      if (scopes.length && !scopes.includes(PAYOUTS_SCOPE)) {
        return {
          success: false,
          message:
            `These credentials work, but this PayPal app is not approved for Payouts. ` +
            `Enable Payouts on the app in your PayPal developer dashboard, then test again.`,
        };
      }
      return { success: true, message: `Connected to PayPal (${where}) with Payouts enabled` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, message };
    }
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

  private toBatchResult(res: unknown): PayoutBatchResult {
    const r = res as {
      batch_header?: { payout_batch_id?: string; batch_status?: string };
      items?: {
        payout_item_id?: string;
        transaction_status?: string;
        errors?: { message?: string };
        payout_item?: { sender_item_id?: string };
      }[];
    };
    return {
      batchId: r.batch_header?.payout_batch_id ?? '',
      batchStatus: r.batch_header?.batch_status ?? '',
      items: (r.items ?? []).map((i) => ({
        senderItemId: i.payout_item?.sender_item_id ?? '',
        payoutItemId: i.payout_item_id ?? '',
        transactionStatus: i.transaction_status ?? '',
        errorMessage: i.errors?.message,
      })),
    };
  }

  private async call(orgId: string, method: 'GET' | 'POST', path: string, body?: unknown) {
    const { host, token } = await this.authorise(orgId);
    const res = await fetch(`${host}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    if (!res.ok) {
      // The status code is load-bearing: a 5xx is safely retryable with the
      // same `sender_batch_id`, and a 4xx is not. The caller decides, so it
      // needs both.
      const err = new PayPalError(
        `PayPal ${method} ${path} failed: ${res.status} ${text.slice(0, 400)}`,
        res.status,
      );
      this.logger.error({ orgId, path, status: res.status }, 'PayPal call failed');
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }

  private async authorise(orgId: string): Promise<{ host: string; token: string; scopes: string[] }> {
    const config = await this.prisma.payPalConfig.findUnique({ where: { orgId } });
    if (!config) throw new PayPalError('PayPal is not configured for this organization', 412);

    const host = HOSTS[config.environment === 'live' ? 'live' : 'sandbox'];
    const cached = this.tokens.get(orgId);
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return { host, token: cached.token, scopes: cached.scopes };
    }

    const secret = this.crypto.decrypt(config.clientSecretEnc);
    const basic = Buffer.from(`${config.clientId}:${secret}`).toString('base64');
    const res = await fetch(`${host}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      throw new PayPalError(`PayPal auth failed: ${res.status}`, res.status);
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
      scope?: string;
    };
    const scopes = (json.scope ?? '').split(' ').filter(Boolean);
    this.tokens.set(orgId, {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
      scopes,
    });
    return { host, token: json.access_token, scopes };
  }
}

/** Carries the HTTP status, because 5xx is retryable with the same batch id and 4xx is not. */
export class PayPalError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PayPalError';
  }

  /** PayPal's own guidance: a 5nn may be retried with the same `sender_batch_id`. */
  get retryable(): boolean {
    return this.status >= 500;
  }
}
