import { Controller, Headers, HttpCode, Logger, Param, Post, Req } from '@nestjs/common';
import { Limit } from '../../common/limits/limit.decorator';
import type { Request } from 'express';
import { PayPalClient } from './paypal.client';
import { PayoutRunService } from './payout-run.service';

/**
 * Where PayPal tells us what happened to a payout (Plan 25 §8).
 *
 * Public by necessity — PayPal has no credentials of ours — and therefore
 * authenticated by signature instead. The org is in the path because a webhook
 * carries nothing that identifies which of our organizations it belongs to; it
 * is not a secret, and it grants nothing, because an unsigned delivery is
 * dropped whatever path it arrives on.
 *
 * Always answers 200. A webhook receiver that returns 500 because our database
 * was busy earns a retry storm from PayPal and tells them nothing useful; what
 * we failed to record is recovered by the sweep, not by their retries.
 */
// Every delivery from PayPal arrives from PayPal, so the default per address is
// a batch of payouts silently losing its tail. Raised rather than skipped:
// verification costs an outbound call to PayPal per request, so an unbounded
// public route here would be a way to make this server do work on someone
// else's say-so.
@Limit('webhooks.paypal')
@Controller('webhooks/paypal')
export class PayoutWebhookController {
  private readonly logger = new Logger(PayoutWebhookController.name);

  constructor(
    private readonly paypal: PayPalClient,
    private readonly runs: PayoutRunService,
  ) {}

  @Post(':orgId')
  @HttpCode(200)
  async receive(
    @Param('orgId') orgId: string,
    @Headers() headers: Record<string, string>,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    // The bytes as delivered. PayPal's verification hashes the body, so a
    // re-serialised copy of the parsed object fails on nothing more than a
    // space or an escaped character.
    const raw = req.rawBody?.toString('utf8');
    if (!raw) {
      this.logger.error({ orgId }, 'Webhook arrived without its raw body — cannot verify');
      return { received: true };
    }

    let verified = false;
    try {
      verified = await this.paypal.verifyWebhook(orgId, headers, raw);
    } catch (err) {
      this.logger.error({ orgId, err }, 'Could not verify webhook signature');
    }
    if (!verified) {
      // Logged loudly and dropped. Anyone can POST here, and a forged delivery
      // that was honoured would mark unsent money as paid.
      this.logger.error({ orgId, type: safeType(raw) }, 'Rejected an unverified PayPal webhook');
      return { received: true };
    }

    try {
      await this.handle(orgId, JSON.parse(raw));
    } catch (err) {
      this.logger.error({ orgId, err }, 'Verified webhook could not be applied');
    }
    return { received: true };
  }

  private async handle(orgId: string, event: PayPalWebhookEvent) {
    const type = event.event_type ?? '';

    if (type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
      const resource = event.resource ?? {};
      const senderItemId = resource.payout_item?.sender_item_id;
      if (!senderItemId) {
        this.logger.warn({ orgId, type }, 'Payout item webhook carried no sender_item_id');
        return;
      }
      await this.runs.applyBatchResult(resource.payout_batch_id ?? '', [
        {
          senderItemId,
          payoutItemId: resource.payout_item_id ?? '',
          transactionStatus: resource.transaction_status ?? '',
          errorMessage: resource.errors?.message,
        },
      ]);
      return;
    }

    if (type.startsWith('PAYMENT.PAYOUTSBATCH.')) {
      // A batch event says nothing per-seller, so it is used as a prompt to go
      // and read the batch rather than as a fact about anybody's money.
      const batchId = event.resource?.batch_header?.payout_batch_id;
      if (batchId) await this.runs.reconcileBatch(orgId, batchId);
      return;
    }

    this.logger.log({ orgId, type }, 'Ignoring a PayPal event we do not act on');
  }
}

/** Only the parts we read. PayPal sends a great deal more. */
interface PayPalWebhookEvent {
  event_type?: string;
  resource?: {
    payout_item_id?: string;
    payout_batch_id?: string;
    transaction_status?: string;
    errors?: { message?: string };
    payout_item?: { sender_item_id?: string };
    batch_header?: { payout_batch_id?: string };
  };
}

/** The event type, for a log line about a body we have decided not to trust. */
function safeType(raw: string): string {
  try {
    return String((JSON.parse(raw) as PayPalWebhookEvent).event_type ?? 'unknown');
  } catch {
    return 'unparseable';
  }
}
