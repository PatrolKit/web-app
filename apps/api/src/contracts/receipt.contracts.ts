import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * Which swap's receipt to send. The seller comes from the route or the guard.
 *
 * `channel` is the caller's choice of how, for a counter where somebody says
 * "just text it to me" — a menu offering Print / Email / Text cannot offer a
 * row that says Text and sends an email. Omit it and the server resolves as it
 * always has, verified email first, which is what the web relies on.
 *
 * It chooses the channel, never the destination: that stays resolved here from
 * the seller's verified columns, so the worst a stolen station token can do is
 * send a seller their own receipt by the other one.
 */
export const SendReceiptSchema = z.object({
  swapId: z.string().min(1),
  channel: z.enum(['EMAIL', 'SMS']).optional(),
});
export class SendReceiptDto extends createZodDto(SendReceiptSchema) {}

/** Creating one. `stationId` records where it happened, when a station is known. */
export const CreateReceiptSchema = z.object({
  swapId: z.string().min(1),
  stationId: z.string().min(1).optional(),
});
export class CreateReceiptDto extends createZodDto(CreateReceiptSchema) {}

/** What a send reports back, for the web and for iOS (Plan 24 §11). */
export interface SendReceiptResponse {
  receiptId: string;
  channel: 'EMAIL' | 'SMS';
  /** The address or number it went to, so the UI can name it. */
  destination: string;
  status: 'SENT' | 'SUPPRESSED' | 'FAILED';
  sentAt: string;
  url: string;
}

/** One line of a frozen receipt. */
export interface PublicReceiptLine {
  name: string;
  sku: string;
  /** Null for a ticket not yet priced when the receipt was made (Plan 32). */
  priceCents: number | null;
}

/** What `/public/receipts/:token` serves the page. */
export interface PublicReceiptResponse {
  id: string;
  token: string;
  orgName: string;
  orgLogoUrl: string | null;
  swapTitle: string;
  sellerName: string;
  payoutLabel: string | null;
  /** Of the priced lines only. */
  totalCents: number;
  itemCount: number;
  /** Lines with no price yet, which `totalCents` leaves out. */
  unpricedCount: number;
  createdAt: string;
  /** The swap's zone ("America/New_York"): show `createdAt` in it, not the viewer's. */
  timeZone: string;
  url: string;
  /** The status page this receipt links to; `layout.link` says the same, and is the answer now. */
  trackUrl: string;
  /** What the receipt shows, per its swap's settings now (Plan 36). */
  layout: import('../ski-swap/receipt-layout').ReceiptLayout;
  lines: PublicReceiptLine[];
}
