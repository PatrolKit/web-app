import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createId } from '@paralleldrive/cuid2';
import { randomBytes } from 'crypto';
import type { Receipt, ReceiptLine } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../common/services/idempotency.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';
import { displayName } from '../common/util/person';
import type { SendOutcome } from '../common/messaging/send-outcome';
import { receiptEmail, receiptSms } from './receipt-templates';
import { emailHint, RECEIPT_SIGN_IN_SELECT, receiptLayout, receiptSignInEmail, RECEIPTS_OFF, type ReceiptLayout } from './receipt-layout';
import { LIMITS } from '../common/limits/limits';
import { LimitUsageService } from '../common/limits/limit-usage.service';

/** What a seller's receipt is worth putting in front of them. */
export interface ReceiptView {
  id: string;
  token: string;
  orgName: string;
  /**
   * The stored value, which is a `data:` URI. Fine in a browser, useless in an
   * email — see `logoImageUrl`.
   */
  orgLogoUrl: string | null;
  /**
   * The same logo, but only when a mail client could actually fetch it.
   *
   * `orgLogoUrl` is an ordinary public URL wherever S3 is configured, which is
   * how the seller site renders it today. Without S3 the upload falls back to a
   * `data:` URI, which mail clients strip — and which in any case does not fit
   * the column, so no such logo exists. Null either way, rather than an `<img>`
   * that resolves to a broken-image icon beside the club's name.
   */
  logoImageUrl: string | null;
  swapTitle: string;
  sellerName: string;
  payoutLabel: string | null;
  /** Of the priced lines only (Plan 32). */
  totalCents: number;
  itemCount: number;
  /** Lines of tickets not yet priced, which `totalCents` leaves out. */
  unpricedCount: number;
  createdAt: Date;
  /** The swap's zone, which `createdAt` is given in wherever it's shown. */
  timeZone: string;
  /** This receipt, frozen. */
  url: string;
  /**
   * The seller's live page: everything they have at this org, not only what is
   * on this receipt. The receipt says what they dropped off; this says what has
   * happened to it since.
   */
  trackUrl: string;
  /** The PatrolKit mark, for the foot of an email led by somebody else's name. */
  brandMarkUrl: string;
  /**
   * What this receipt shows, per the swap's settings now (Plan 36): columns,
   * link, printing and fine print. Every renderer draws from it.
   */
  layout: ReceiptLayout;
  /** `priceCents` is null for a ticket not yet priced. */
  lines: { name: string; sku: string; priceCents: number | null }[];
}

export type ReceiptChannel = 'EMAIL' | 'SMS';

export interface SendResult {
  receiptId: string;
  channel: ReceiptChannel;
  destination: string;
  status: 'SENT' | 'SUPPRESSED' | 'FAILED';
  /**
   * ISO, not a `Date`.
   *
   * A replayed send comes back through JSON, where a `Date` has already become
   * a string — so returning one here would mean the first call and its retry
   * had different types for the same field.
   */
  sentAt: string;
  url: string;
}

/**
 * A check-in, frozen, and the two ways to hand it over (Plan 24).
 *
 * Creating a receipt and sending one are separate on purpose: `finish()` makes
 * the record because that is the moment it is true, and nothing goes out until
 * somebody presses a button.
 */
@Injectable()
export class ReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
    private readonly config: ConfigService,
    private readonly idempotency: IdempotencyService,
    private readonly usage: LimitUsageService,
  ) {}

  /**
   * Freezes what this seller has at this swap, right now.
   *
   * Everything the public page needs is copied in rather than joined later —
   * an org rename, a swap retitle or a tidied item name must not reach back and
   * change what somebody was handed.
   */
  async snapshot(
    orgId: string,
    swapId: string,
    sellerId: string,
    stationId?: string | null,
  ): Promise<Receipt> {
    const seller = await this.prisma.sellerProfile.findFirst({
      where: { id: sellerId, membership: { orgId } },
      include: { membership: { include: { user: true, org: true } } },
    });
    if (!seller) throw new NotFoundException('Seller no longer exists');

    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId } });
    if (!swap) throw new NotFoundException('Swap no longer exists');

    const items = await this.prisma.swapItem.findMany({
      where: { orgId, swapId, sellerId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, sku: true, priceCents: true },
    });

    const user = seller.membership.user;
    return this.prisma.receipt.create({
      data: {
        id: createId(),
        orgId,
        swapId,
        sellerId,
        stationId: stationId ?? null,
        token: newToken(),
        orgName: seller.membership.org.name,
        orgLogoUrl: seller.membership.org.logoUrl,
        swapTitle: swap.title,
        sellerName: displayName(user, seller.businessName),
        payoutLabel: payoutLabel(user),
        // Priced items only: a ticket checked in before its price is "price to
        // come", never $0 (Plan 32).
        totalCents: items.reduce((sum, i) => sum + (i.priceCents ?? 0), 0),
        itemCount: items.length,
        lines: {
          create: items.map((item, position) => ({
            id: createId(),
            itemId: item.id,
            name: item.name,
            sku: item.sku,
            priceCents: item.priceCents,
            position,
          })),
        },
      },
    });
  }

  /**
   * The receipt to send, minting one when what we hold no longer describes the
   * seller's items.
   *
   * Re-sending yesterday's receipt after three more items went on is not a
   * re-send, it is a wrong receipt. Comparing the lines is cheap, and means the
   * common case — a seller who lost the paper — reuses the record and its link
   * rather than minting a near-duplicate with a second URL.
   *
   * Also the path for a seller who never self-checked-in at all: staff enter
   * items for proxy and business sellers, and those have no `finish()` in their
   * history, but the sellers list still needs a working button.
   */
  async currentFor(
    orgId: string,
    swapId: string,
    sellerId: string,
    /**
     * Where it is being minted, used only if one has to be. A receipt that
     * already describes the seller keeps whichever station it was made at —
     * the counter it happened at does not change because somebody looked at it
     * again from the sellers list.
     */
    stationId?: string | null,
  ): Promise<Receipt> {
    await this.assertReceiptsOn(orgId, swapId);
    const latest = await this.prisma.receipt.findFirst({
      where: { orgId, swapId, sellerId },
      orderBy: { createdAt: 'desc' },
      include: { lines: { orderBy: { position: 'asc' } } },
    });
    if (latest && (await this.stillDescribes(latest, latest.lines))) return latest;
    return this.snapshot(orgId, swapId, sellerId, stationId ?? undefined);
  }

  /**
   * Whether a receipt still says what the seller's items say.
   *
   * On the set of observable facts, not on a timestamp: an edit that changed
   * nothing a seller could see — a photo added, a consignment recorded — should
   * not mint a receipt.
   */
  private async stillDescribes(receipt: Receipt, lines: ReceiptLine[]): Promise<boolean> {
    const items = await this.prisma.swapItem.findMany({
      // A withdrawn item is a change the seller can see, so a receipt listing
      // one no longer describes them and has to be reissued.
      where: { orgId: receipt.orgId, swapId: receipt.swapId, sellerId: receipt.sellerId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, sku: true, priceCents: true },
    });
    if (items.length !== lines.length) return false;
    // A price filled in later is a change the seller can see, so it reissues.
    const key = (x: { itemId?: string | null; id?: string; name: string; sku: string; priceCents: number | null }) =>
      `${x.itemId ?? x.id}|${x.name}|${x.sku}|${x.priceCents}`;
    const have = new Set(lines.map(key));
    return items.every((i) => have.has(key(i)));
  }

  /**
   * Sends a receipt, and writes down what happened either way.
   *
   * Inline rather than queued: the operator is standing there watching, and a
   * queue would move the failure somewhere nobody is looking.
   */
  async send(params: {
    orgId: string;
    swapId: string;
    sellerId: string;
    /** The caller's choice. Absent, the server resolves it — see `resolveChannel`. */
    channel?: ReceiptChannel | null;
    actorUserId?: string | null;
    idempotencyKey?: string;
    /**
     * For a seller sending their own copy (Plan 26 §6): at most a few an hour
     * to one destination. Staff sends are not limited — staff are accountable
     * for them — and are not counted.
     */
    limitPerDestination?: boolean;
  }): Promise<SendResult> {
    const { orgId, swapId, sellerId } = params;

    /*
     * The one write here that is not idempotent by nature.
     *
     * `currentFor` is — the same items give back the same receipt — but the
     * dispatch under it is not: every call puts another message in somebody's
     * inbox and writes another delivery row. A client that queues sends for an
     * offline counter retries them on a schedule it controls, and a lost
     * response would otherwise become two emails to a member of the public, or
     * five. So a retry with the same key replays the first answer instead.
     *
     * Scoped to the org, like every other key here: the value is client-chosen,
     * and two callers landing on the same string must not read each other's
     * results.
     */
    if (params.idempotencyKey) {
      const cached = await this.idempotency.getCached(`receipt-send:${orgId}`, params.idempotencyKey);
      if (cached) return cached as unknown as SendResult;
    }
    const receipt = await this.currentFor(orgId, swapId, sellerId);
    const view = await this.view(receipt);

    const seller = await this.prisma.sellerProfile.findFirstOrThrow({
      where: { id: sellerId, membership: { orgId } },
      include: { membership: { include: { user: true } } },
    });
    const user = seller.membership.user;

    const channel = resolveChannel(params.channel ?? null, user, await this.sms.enabled());
    const destination = (channel === 'EMAIL' ? user.verifiedEmail : user.verifiedPhone)!;
    if (params.limitPerDestination) await this.assertDestinationNotLimited(destination, swapId);

    let outcome: SendOutcome;
    try {
      outcome =
        channel === 'EMAIL'
          ? await this.mail.sendReceipt(destination, view.orgName, receiptEmail(view))
          : await this.sms.send(destination, receiptSms(view));
    } catch (err) {
      // MailService still throws as well as reporting. A send that failed is a
      // row like any other — losing it would leave the sellers list claiming
      // nothing was ever tried.
      outcome = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }

    const status = outcome.status.toUpperCase() as SendResult['status'];
    const delivery = await this.prisma.receiptDelivery.create({
      data: {
        id: createId(),
        receiptId: receipt.id,
        channel,
        destination,
        status,
        providerRef: outcome.status === 'sent' ? (outcome.providerRef ?? null) : null,
        // Why nothing went, for both of the ways nothing goes. A suppressed row
        // that says only SUPPRESSED cannot tell somebody looking at it months
        // later whether a box had messaging switched off or whether texts did
        // not work anywhere yet.
        error:
          outcome.status === 'failed' ? outcome.error
          : outcome.status === 'suppressed' ? (outcome.reason ?? null)
          : null,
        actorUserId: params.actorUserId ?? null,
      },
    });

    const result: SendResult = {
      receiptId: receipt.id,
      channel,
      destination,
      status,
      sentAt: delivery.createdAt.toISOString(),
      url: view.url,
    };

    // Cached whatever happened, including a failure: a retry of a send that
    // failed should report that failure rather than quietly trying again on a
    // schedule the caller did not choose. A caller who means to try again sends
    // a new key.
    if (params.idempotencyKey) {
      await this.idempotency.save(
        `receipt-send:${orgId}`,
        params.idempotencyKey,
        result as unknown as Record<string, unknown>,
      );
    }

    return result;
  }

  /**
   * Refuses a seller's own send once their destination has had its share.
   *
   * Per destination rather than per account: a seller with two accounts could
   * otherwise point both at one inbox. Counts only sends nobody pressed on the
   * seller's behalf — `actorUserId` null — which are exactly this route's.
   * After the idempotency replay, so a retried request is not a second send.
   */
  private async assertDestinationNotLimited(destination: string, swapId: string): Promise<void> {
    const { limit, windowMs } = LIMITS['receipts.perDestination'];
    const sent = await this.prisma.receiptDelivery.count({
      where: { destination, actorUserId: null, createdAt: { gte: new Date(Date.now() - windowMs) } },
    });
    const refused = sent >= limit;
    this.usage.record({
      limitId: 'receipts.perDestination',
      hits: sent + 1,
      refused,
      keyKind: 'destination',
      where: 'ReceiptService.send',
      attribution: { swapId },
    });
    if (refused) {
      throw new HttpException(
        {
          message: 'This receipt has been sent a few times already. Try again in an hour.',
          code: 'TOO_MANY_RECEIPTS',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * The record for a check-in that happened somewhere else — an iPad printing
   * its own receipt, or staff on the sellers list.
   *
   * Goes through `currentFor` rather than `snapshot` so a retried call after a
   * dropped response returns what it made the first time instead of a second
   * receipt with a second link.
   */
  async createFor(
    orgId: string,
    swapId: string,
    sellerId: string,
    stationId?: string | null,
  ): Promise<ReceiptView> {
    await this.assertReceiptsOn(orgId, swapId);
    const existing = await this.prisma.receipt.findFirst({
      where: { orgId, swapId, sellerId },
      orderBy: { createdAt: 'desc' },
      include: { lines: { orderBy: { position: 'asc' } } },
    });
    if (existing && (await this.stillDescribes(existing, existing.lines))) {
      return this.view(existing);
    }
    return this.view(await this.snapshot(orgId, swapId, sellerId, stationId));
  }

  /** The receipt behind a public link, or nothing if it was revoked. */
  async byToken(token: string): Promise<ReceiptView> {
    const receipt = await this.prisma.receipt.findUnique({ where: { token } });
    if (!receipt || receipt.revokedAt) throw new NotFoundException('That receipt is not available');
    const view = await this.view(receipt);
    // A swap that gives no receipts shows none, even one already handed out (D5).
    if (view.layout.mode === 'NONE') throw new NotFoundException('That receipt is not available');
    return view;
  }

  /**
   * What a receipt's sign-in link shows before sending anything: the seller's
   * email, masked (Plan 36 D3). A 404 whenever the receipt shouldn't offer
   * sign-in, the same as for a token that doesn't exist.
   */
  async signInHint(token: string): Promise<{ emailHint: string }> {
    const email = receiptSignInEmail(await this.prisma.receipt.findUnique({ where: { token }, select: RECEIPT_SIGN_IN_SELECT }));
    if (!email) throw new NotFoundException('That receipt is not available');
    return { emailHint: emailHint(email) };
  }

  async revoke(orgId: string, receiptId: string): Promise<void> {
    const receipt = await this.prisma.receipt.findFirst({ where: { id: receiptId, orgId } });
    if (!receipt) throw new NotFoundException('Receipt not found');
    await this.prisma.receipt.update({
      where: { id: receipt.id },
      data: { revokedAt: receipt.revokedAt ?? new Date() },
    });
  }

  /** A seller's receipts, newest first, with what happened to each. */
  async listForSeller(orgId: string, swapId: string, sellerId: string) {
    const receipts = await this.prisma.receipt.findMany({
      where: { orgId, swapId, sellerId },
      orderBy: { createdAt: 'desc' },
      include: { deliveries: { orderBy: { createdAt: 'desc' } } },
    });
    return receipts.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      itemCount: r.itemCount,
      totalCents: r.totalCents,
      revokedAt: r.revokedAt,
      url: this.urlFor(r.token),
      deliveries: r.deliveries.map((d) => ({
        channel: d.channel,
        destination: d.destination,
        status: d.status,
        error: d.error,
        createdAt: d.createdAt,
      })),
    }));
  }

  /**
   * Refuses to make or send a receipt for a swap that gives none (D4). Checked
   * before anything is written, so a refused call leaves no receipt behind.
   */
  async assertReceiptsOn(orgId: string, swapId: string): Promise<void> {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { receiptMode: true } });
    if (swap?.receiptMode === 'NONE') throw new ConflictException(RECEIPTS_OFF);
  }

  /** This seller's receipt layout at this swap, per its settings now (Plan 36). */
  async layoutFor(swapId: string, sellerId: string, receiptToken: string | null): Promise<ReceiptLayout> {
    return (await this.layoutAndZone(swapId, sellerId, receiptToken)).layout;
  }

  /** The layout, and the swap's time zone beside it, from one read of the swap. */
  private async layoutAndZone(swapId: string, sellerId: string, receiptToken: string | null) {
    const swap = await this.prisma.skiSwap.findUniqueOrThrow({
      where: { id: swapId },
      include: { org: { select: { slug: true } } },
    });
    const layout = receiptLayout(swap, {
      sellerSiteUrl: this.config.get<string>('app.sellerSiteUrl', 'http://localhost:3000'),
      appUrl: this.config.get<string>('app.appUrl', 'http://localhost:3000'),
      orgSlug: swap.org.slug,
      sellerId,
      receiptToken,
    });
    return { layout, timeZone: swap.timeZone };
  }

  private async view(receipt: Receipt): Promise<ReceiptView> {
    const lines = await this.prisma.receiptLine.findMany({
      where: { receiptId: receipt.id },
      orderBy: { position: 'asc' },
      select: { name: true, sku: true, priceCents: true },
    });
    const { layout, timeZone } = await this.layoutAndZone(receipt.swapId, receipt.sellerId, receipt.token);
    return {
      id: receipt.id,
      token: receipt.token,
      orgName: receipt.orgName,
      orgLogoUrl: receipt.orgLogoUrl,
      logoImageUrl: emailableLogo(receipt.orgLogoUrl),
      swapTitle: receipt.swapTitle,
      sellerName: receipt.sellerName,
      payoutLabel: receipt.payoutLabel,
      totalCents: receipt.totalCents,
      itemCount: receipt.itemCount,
      unpricedCount: lines.filter((l) => l.priceCents === null).length,
      createdAt: receipt.createdAt,
      timeZone,
      url: this.urlFor(receipt.token),
      // Kept for iPad builds that read it; `layout.link` is the answer now.
      trackUrl: layout.link?.url ?? this.sellerSite(`/s/${receipt.sellerId}`),
      brandMarkUrl: this.sellerSite('/logo-mark.png'),
      layout,
      lines,
    };
  }

  /**
   * Absolute, and resolved here.
   *
   * The link is texted once and opened weeks later, so a relative path is
   * useless and an origin taken from whoever made the request is a guess.
   */
  private urlFor(token: string): string {
    return this.sellerSite(`/r/${token}`);
  }

  private sellerSite(path: string): string {
    const base = this.config.get<string>('app.sellerSiteUrl', 'http://localhost:3000');
    return `${base.replace(/\/$/, '')}${path}`;
  }


}

/** The verified columns a send resolves through. */
export interface VerifiedContacts {
  verifiedEmail: string | null;
  verifiedPhone: string | null;
}

/**
 * Which channel a send uses, and the refusal when it cannot use one.
 *
 * Verified contacts only, whether the caller asked for a channel or not.
 * `email` and `phone` are claims — indexed, deliberately not unique, and
 * possibly somebody else's. `verifiedEmail` and `verifiedPhone` are the ones
 * that have been proved, and are already what a payout resolves through. A
 * receipt carries a name, a list of what somebody owns, and for a mailed-check
 * seller an address.
 *
 * So `requested` picks between the proved contacts; it cannot conjure one. A
 * caller naming a channel the seller has not proved is refused exactly as one
 * who has nothing to send to, because from here those are the same fact.
 */
export function resolveChannel(
  requested: ReceiptChannel | null,
  user: VerifiedContacts,
  smsOn: boolean,
): ReceiptChannel {
  // Texting off (Plan 29): a text is never chosen, and asking for one is told
  // what to do instead — before the "no verified phone" sentence, which would
  // send staff off to verify a phone that cannot be.
  if (!smsOn && requested === 'SMS') {
    throw new BadRequestException({ message: 'Texting is off. Send it by email.', code: 'SMS_OFF' });
  }
  const verified: Record<ReceiptChannel, string | null> = {
    EMAIL: user.verifiedEmail,
    SMS: smsOn ? user.verifiedPhone : null,
  };
  // Unasked, the order is the old one: email first, phone second. The web sends
  // no channel and must keep getting what it got before.
  const channel = requested ?? (verified.EMAIL ? 'EMAIL' : verified.SMS ? 'SMS' : null);
  if (channel && verified[channel]) return channel;

  /*
   * Two sentences, because a volunteer reads this one and acts on it.
   *
   * "no verified email or phone" is the truth when there is nothing at all, and
   * the handoff tells iOS to render it. Said to somebody who tapped Text for a
   * seller whose email is proved, it is false in the way that matters: it reads
   * as "do not bother trying Email either", and Email would have worked.
   */
  if (!verified.EMAIL && !verified.SMS) {
    throw new BadRequestException(
      smsOn
        ? 'This seller has no verified email or phone, so there is nowhere to send a receipt.'
        : 'This seller has no verified email, so there is nowhere to send a receipt.',
    );
  }
  throw new BadRequestException(
    channel === 'SMS'
      ? 'This seller has no verified phone, so a receipt cannot be texted.'
      : 'This seller has no verified email, so a receipt cannot be emailed.',
  );
}

/**
 * A logo a mail client can fetch, or nothing.
 *
 * Only absolute http(s): a `data:` URI is stripped by Gmail and Outlook, and a
 * relative path in an email means nothing at all. See `ReceiptView`.
 */
function emailableLogo(logoUrl: string | null): string | null {
  return logoUrl && /^https?:\/\//i.test(logoUrl) ? logoUrl : null;
}

/**
 * 32 characters from 24 random bytes.
 *
 * Not derived from the receipt id and not signed: a signed token cannot be
 * revoked without keeping a list of what has been revoked, which is the table
 * this already is.
 */
function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Where the money was going, in the words the seller chose. */
function payoutLabel(user: {
  payoutMethod: string | null;
  payoutHandle: string | null;
}): string | null {
  if (!user.payoutMethod) return null;
  const method = user.payoutMethod === 'CHECK' ? 'Check' : titleish(user.payoutMethod);
  return user.payoutHandle ? `${method} — ${user.payoutHandle}` : method;
}

function titleish(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
