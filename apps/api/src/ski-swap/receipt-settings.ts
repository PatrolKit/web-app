import { BadRequestException } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';

/**
 * A swap's receipt settings (Plan 36): what a receipt is, what it links to,
 * whether it prints and on what, and its optional fine print.
 */
export const RECEIPT_MODES = ['ITEMIZED', 'STATUS_ONLY', 'NONE'] as const;
export type ReceiptMode = (typeof RECEIPT_MODES)[number];

export const RECEIPT_LINKS = ['NONE', 'SKU_LOOKUP', 'SELLER_STATUS', 'SELLER_LOGIN'] as const;
export type ReceiptLink = (typeof RECEIPT_LINKS)[number];

/** The stocks a receipt can print on (D11). Helper-label strip stock can't carry one. */
export const RECEIPT_PAPER_SIZES = ['62x100', '50x30'] as const;
export type ReceiptPaperSize = (typeof RECEIPT_PAPER_SIZES)[number];

/** Fine print's limit, in characters of text rather than markup (D13). */
export const FINE_PRINT_MAX_CHARS = 2000;

export interface ReceiptSettings {
  receiptMode: string;
  receiptShowSku: boolean;
  receiptShowName: boolean;
  receiptShowPrice: boolean;
  receiptLink: string;
  receiptPrintEnabled: boolean;
  receiptPaperSize: string;
  receiptFinePrintEnabled: boolean;
  receiptFinePrint: string | null;
}

/**
 * Fine print as a small, safe subset of HTML (D13): paragraphs, line breaks,
 * bold, italic, http/https/mailto links and lists. Everything else, attributes
 * and `javascript:` links included, is stripped. Run on save and again on
 * render, so nothing else can reach an email or the receipt page.
 */
export function sanitizeFinePrint(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: { b: 'strong', i: 'em' },
  }).trim();
}

/** The text a reader sees, for the character limit and the "is it empty" check. */
export function finePrintText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();
}

/**
 * Refuses settings that can't make a receipt, judged as they'll stand after
 * the write (D6, D7, D13). A link to a status page that's off is fine: it's
 * resolved when the receipt is shown, and simply absent then (D2).
 */
export function assertReceiptSettings(s: ReceiptSettings): void {
  if (s.receiptMode === 'STATUS_ONLY' && s.receiptLink === 'NONE') {
    throw new BadRequestException('A status-page-only receipt needs a status page to link to.');
  }
  if (s.receiptMode === 'ITEMIZED' && !s.receiptShowSku && !s.receiptShowName) {
    throw new BadRequestException('An itemized receipt needs each item’s SKU or name, or both.');
  }
  // No receipt has no fine print to judge: the dialog hides it under None.
  if (s.receiptMode !== 'NONE' && s.receiptFinePrintEnabled) {
    const text = finePrintText(s.receiptFinePrint ?? '');
    if (!text) throw new BadRequestException('Add some fine print, or turn it off.');
    if (text.length > FINE_PRINT_MAX_CHARS) {
      throw new BadRequestException(`Fine print is limited to ${FINE_PRINT_MAX_CHARS.toLocaleString('en-US')} characters.`);
    }
  }
}
