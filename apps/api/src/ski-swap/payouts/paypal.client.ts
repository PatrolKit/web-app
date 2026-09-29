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
  /** Drops anything held for this org's credentials, because they just changed. */
  abstract forget(orgId: string): void;
}

/**
 * A payout batch id that cannot exist, for asking PayPal whether this app may
 * read payouts at all. See `testConnection`.
 */
const PROBE_BATCH_ID = 'PATROLKIT-CONNECTION-TEST';

const HOSTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
} as const;

@Injectable()
export class HttpPayPalClient extends PayPalClient {
  private readonly logger = new Logger(HttpPayPalClient.name);
  /**
   * Short-lived, and re-fetched rather than refreshed. Dropped when the org's
   * credentials change: a token outlives them by up to nine hours otherwise.
   */
  private tokens = new Map<string, { token: string; expiresAt: number }>();

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
   * moment that matters, so it is asked here, while somebody is still looking at
   * the settings screen.
   *
   * Asked by trying, not by reading the token's scopes. PayPal names the Payouts
   * scope differently from its own documentation — a live app with Payouts on
   * is granted `https://uri.paypal.com/payments/payouts` — and a check that
   * matched the documented name told an org with Payouts enabled that it was
   * not. So this looks up a payout batch that cannot exist: an app allowed to
   * use Payouts is told it was not found, and one that is not is refused.
   *
   * Always with a fresh token, so a test straight after changing the app's
   * permissions answers about the app as it is now.
   */
  async testConnection(orgId: string): Promise<{ success: boolean; message: string }> {
    this.forget(orgId);

    let host: string;
    let token: string;
    try {
      ({ host, token } = await this.authorise(orgId));
    } catch (err) {
      if (err instanceof PayPalError && err.status === 401) {
        return { success: false, message: 'PayPal did not accept this Client ID and Secret. Check both, and that the environment matches the app.' };
      }
      return { success: false, message: err instanceof Error ? err.message : 'Unknown error' };
    }
    const where = host.includes('sandbox') ? 'sandbox' : 'live';

    // Fetched here rather than through `call`, which logs every non-2xx as a
    // failure — and the answer this is hoping for is a 404.
    let status: number;
    try {
      status = (await fetch(`${host}/v1/payments/payouts/${PROBE_BATCH_ID}`, {
        headers: { authorization: `Bearer ${token}` },
      })).status;
    } catch {
      return { success: false, message: 'Could not reach PayPal' };
    }

    if (status === 404 || status === 200) {
      return { success: true, message: `Connected to PayPal (${where}) with Payouts enabled` };
    }
    if (status === 401 || status === 403) {
      return {
        success: false,
        message:
          `These credentials work, but PayPal refused to let this app use Payouts. ` +
          `Check that Payouts is enabled on the app in your PayPal developer dashboard, and that ` +
          `PayPal has approved Payouts for this ${where} account, then test again.`,
      };
    }
    this.logger.warn({ orgId, status }, 'Unexpected answer to the Payouts connection probe');
    return { success: false, message: `PayPal answered the Payouts check with HTTP ${status}. Try again in a minute.` };
  }

  forget(orgId: string): void {
    this.tokens.delete(orgId);
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

  private async authorise(orgId: string): Promise<{ host: string; token: string }> {
    const config = await this.prisma.payPalConfig.findUnique({ where: { orgId } });
    if (!config) throw new PayPalError('PayPal is not configured for this organization', 412);

    const host = HOSTS[config.environment === 'live' ? 'live' : 'sandbox'];
    const cached = this.tokens.get(orgId);
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return { host, token: cached.token };
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
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.tokens.set(orgId, {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    });
    return { host, token: json.access_token };
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
