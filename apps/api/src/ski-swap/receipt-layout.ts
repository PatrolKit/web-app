import { sanitizeFinePrint, type ReceiptPaperSize } from './receipt-settings';

/**
 * Everything a receipt renderer needs to know, decided once (Plan 36): the
 * email, the text message, the receipt page, the bridge's printed receipt and
 * the iPad's all draw from this, so no channel decides for itself.
 */
export type LinkKind = 'SKU_LOOKUP' | 'SELLER_STATUS' | 'SELLER_LOGIN';

export interface ReceiptLayout {
  mode: 'ITEMIZED' | 'STATUS_ONLY' | 'NONE';
  show: { sku: boolean; name: boolean; price: boolean };
  /** Null for no link, or when the chosen status page has been turned off (D2). */
  link: { url: string; kind: LinkKind } | null;
  /** Null when receipts don't print: printing off, or no receipt at all. */
  print: { paperSize: ReceiptPaperSize } | null;
  /** Sanitized HTML for the email and the receipt page; null when off. */
  finePrint: string | null;
}

export interface LayoutSwap {
  slug: string;
  skuLookupEnabled: boolean;
  sellerLookupEnabled: boolean;
  sellerLoginEnabled: boolean;
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

export interface LayoutUrls {
  /** e.g. https://skiswap.patrolkit.io */
  sellerSiteUrl: string;
  /** e.g. https://patrolkit.io */
  appUrl: string;
  orgSlug: string;
  sellerId: string;
  /** Needed only for a sign-in link; a receipt not yet made has none. */
  receiptToken: string | null;
}

export function receiptLayout(swap: LayoutSwap, urls: LayoutUrls): ReceiptLayout {
  const mode = (['ITEMIZED', 'STATUS_ONLY', 'NONE'] as const).find((m) => m === swap.receiptMode) ?? 'ITEMIZED';
  const none = mode === 'NONE';
  return {
    mode,
    show: { sku: swap.receiptShowSku, name: swap.receiptShowName, price: swap.receiptShowPrice },
    link: none ? null : receiptLink(swap, urls),
    print: none || !swap.receiptPrintEnabled ? null : { paperSize: swap.receiptPaperSize === '50x30' ? '50x30' : '62x100' },
    finePrint: !none && swap.receiptFinePrintEnabled && swap.receiptFinePrint
      ? sanitizeFinePrint(swap.receiptFinePrint) || null
      : null,
  };
}

/** The chosen status page's address for this receipt, or null if it's off (D2, D3). */
function receiptLink(swap: LayoutSwap, urls: LayoutUrls): ReceiptLayout['link'] {
  const site = urls.sellerSiteUrl.replace(/\/$/, '');
  switch (swap.receiptLink) {
    case 'SKU_LOOKUP':
      return swap.skuLookupEnabled
        ? { kind: 'SKU_LOOKUP', url: `${site}/${urls.orgSlug}/${swap.slug}/status` }
        : null;
    case 'SELLER_STATUS':
      return swap.sellerLookupEnabled ? { kind: 'SELLER_STATUS', url: `${site}/s/${urls.sellerId}` } : null;
    case 'SELLER_LOGIN':
      // The token only lets the page *send* a sign-in link to the seller's own
      // inbox; it never signs anyone in, and the email isn't in the URL (D3).
      return swap.sellerLoginEnabled && urls.receiptToken
        ? {
            kind: 'SELLER_LOGIN',
            url: `${urls.appUrl.replace(/\/$/, '')}/app/auth/login?r=${encodeURIComponent(urls.receiptToken)}`,
          }
        : null;
    default:
      return null;
  }
}

/** What a link is for, in the words the receipt uses beside it. */
export const LINK_LABELS: Record<LinkKind, { button: string; scan: string }> = {
  SKU_LOOKUP: { button: 'Check an item', scan: 'Scan to check an item' },
  SELLER_STATUS: { button: 'Track your items', scan: 'Scan to track your items' },
  SELLER_LOGIN: { button: 'Sign in to see your items', scan: 'Scan to sign in and see your items' },
};

/** The receipt-off and printing refusals (D4, D10, D11), worded once. */
export const RECEIPTS_OFF = { code: 'RECEIPTS_OFF', message: 'This swap doesn’t give receipts.' };
export const RECEIPT_PRINT_OFF = { code: 'RECEIPT_PRINT_OFF', message: 'This swap doesn’t print receipts.' };

export function paperLabel(size: string): string {
  return size === '50x30' ? '50 × 30' : size === '62x100' ? '62 × 100' : size.replace('x', ' × ');
}

export function receiptPaperRefusal(required: string, loaded: string) {
  return {
    code: 'RECEIPT_PAPER',
    message: `This swap prints receipts on ${paperLabel(required)} mm labels; this printer has ${paperLabel(loaded)}.`,
  };
}

/**
 * Why a receipt may not print on this printer, or null if it may (D4, D10,
 * D11). One check for every place that prints one: check-in finish, a staff
 * print through a station, the iPad's drawn receipt and the web's Bluetooth
 * print. `loadedPaper` is the printer's stock; null when there's no printer to
 * judge yet, which only the settings can refuse.
 */
export function receiptPrintRefusal(
  swap: { receiptMode: string; receiptPrintEnabled: boolean; receiptPaperSize: string },
  loadedPaper: string | null,
): { code: string; message: string } | null {
  if (swap.receiptMode === 'NONE') return RECEIPTS_OFF;
  if (!swap.receiptPrintEnabled) return RECEIPT_PRINT_OFF;
  if (loadedPaper && loadedPaper !== swap.receiptPaperSize) return receiptPaperRefusal(swap.receiptPaperSize, loadedPaper);
  return null;
}

/** What a receipt's sign-in check reads (Plan 36 D3). */
export const RECEIPT_SIGN_IN_SELECT = {
  revokedAt: true,
  swap: { select: { receiptMode: true, receiptLink: true, sellerLoginEnabled: true } },
  seller: { select: { membership: { select: { user: { select: { verifiedEmail: true } } } } } },
} as const;

/**
 * The verified email a receipt's sign-in link sends to, or null when it
 * shouldn't offer one: revoked, a swap that doesn't link to sign-in, sign-in
 * closed there, or no verified email. The login request and the page's hint
 * both ask this, so they can't disagree.
 */
export function receiptSignInEmail(receipt: {
  revokedAt: Date | null;
  swap: { receiptMode: string; receiptLink: string; sellerLoginEnabled: boolean };
  seller: { membership: { user: { verifiedEmail: string | null } } };
} | null): string | null {
  if (!receipt || receipt.revokedAt) return null;
  const { swap } = receipt;
  if (swap.receiptMode === 'NONE' || swap.receiptLink !== 'SELLER_LOGIN' || !swap.sellerLoginEnabled) return null;
  return receipt.seller.membership.user.verifiedEmail ?? null;
}

/** "dana@example.com" as "d•••@example.com": enough to recognize, not to use. */
export function emailHint(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain ?? ''}`;
}
