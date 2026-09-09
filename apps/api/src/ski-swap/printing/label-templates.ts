import { createCanvas, loadImage, type SKRSContext2D, type Image } from '@napi-rs/canvas';
import QRCode from 'qrcode';
import { code128BModules } from './code128.util';
import { labelFont } from './fonts';
import { BRAND_MARK_PNG } from './brand-mark';
import {
  BRANDING_STRIP_W,
  HEAD_WIDTH_DOTS,
  PAPER_SIZE_HEIGHT_DOTS,
  type PaperSize,
  type PrinterMargins,
} from './geometry';

export interface ItemLabelData {
  name: string;
  priceCents: number;
  sku: string;
}

export interface ReceiptHeaderData {
  orgLogoUrl: string | null;
  date: string;
  sellerName: string;
  phone: string;
  qrUrl: string;
}

// ─── Shared drawing helpers ───────────────────────────────────────────────────

/** Trims `text` with an ellipsis until it fits `maxWidth` at the current font. */
function fit(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s).width > maxWidth) s = s.slice(0, -1);
  return s.slice(0, -1) + '…';
}

/**
 * The rows a line of `size` type actually occupies.
 *
 * These templates used to advance by the point size itself, which is smaller
 * than the line box — at 14 the overlap was a dot or two and invisible, and at
 * 24 it puts an item's descenders into the SKU underneath. It also paginated a
 * receipt differently from the iPad, which measures rendered height, so the
 * same list broke across pages in different places depending on what printed
 * it. 1.2 is Inter's ascent-plus-descent to within a dot at these sizes.
 */
function lineHeight(size: number): number {
  return Math.round(size * 1.2);
}

/**
 * The largest size at or below `preferred` at which `text` fits `maxWidth`.
 *
 * The alternative is `fit`, which cuts the string and adds an ellipsis. That was
 * survivable while this type was small; at the sizes the tag now uses, a long
 * item name loses most of itself rather than a couple of characters. Shrinking
 * keeps the whole name and only costs legibility gradually.
 *
 * Steps by 2 and floors at `minSize`, matching `LabelGenerator.renderFitted` —
 * a tag from a phone and a tag from a bridge have to come out the same.
 */
function fitSize(
  ctx: SKRSContext2D, text: string, preferred: number, minSize: number, maxWidth: number,
): number {
  let size = preferred;
  while (size > minSize) {
    ctx.font = labelFont(size, 'bold');
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  }
  return minSize;
}

/**
 * Sets the fitted font and returns the text to draw at it.
 *
 * The floor can still be too wide — a fifty-character item name does not fit a
 * label at any legible size — and the iPad lets that overflow and be clipped by
 * the grid, which loses both ends of the name and prints into the margin. Below
 * the floor this falls back to what this renderer already did: cut it and mark
 * the cut.
 */
function fitted(
  ctx: SKRSContext2D, text: string, preferred: number, minSize: number, maxWidth: number,
): string {
  ctx.font = labelFont(fitSize(ctx, text, preferred, minSize, maxWidth), 'bold');
  return fit(ctx, text, maxWidth);
}

/**
 * The largest size at or below `preferred` at which *every* string fits.
 *
 * Lines meant to read as one sentence have to share a size. Fitted separately, a
 * short line stays large while a long one steps down, and the pair reads as a
 * mistake rather than as a fit. Steps by 1, matching
 * `LabelGenerator.commonFittedSize`.
 */
function commonFitSize(
  ctx: SKRSContext2D, texts: string[], preferred: number, minSize: number, maxWidth: number,
): number {
  let size = preferred;
  while (size > minSize) {
    ctx.font = labelFont(size, 'bold');
    if (texts.every((t) => ctx.measureText(t).width <= maxWidth)) return size;
    size -= 1;
  }
  return minSize;
}

/**
 * Draws a QR code as filled squares rather than compositing a second canvas.
 * `qrcode` gives the module matrix directly, which avoids a canvas-to-canvas
 * blit and keeps every module aligned to a whole dot — a half-dot QR module on
 * a thermal head is what makes codes fail to scan.
 */
function drawQr(ctx: SKRSContext2D, text: string, x: number, y: number, size: number): void {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const MARGIN = 1;
  const scale = Math.max(1, Math.floor(size / (n + MARGIN * 2)));
  const drawn = (n + MARGIN * 2) * scale;
  // Centre whatever rounding left over, so the code sits where the caller meant.
  const ox = x + Math.floor((size - drawn) / 2);
  const oy = y + Math.floor((size - drawn) / 2);

  ctx.fillStyle = '#fff';
  ctx.fillRect(ox, oy, drawn, drawn);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.data[r * n + c]) {
        ctx.fillRect(ox + (c + MARGIN) * scale, oy + (r + MARGIN) * scale, scale, scale);
      }
    }
  }
}

let brandMark: Image | null = null;
async function getBrandMark(): Promise<Image> {
  if (!brandMark) brandMark = await loadImage(BRAND_MARK_PNG);
  return brandMark;
}

/** Reduces an image to pure black or white — thermal heads cannot print grey. */
function threshold(ctx: SKRSContext2D, w: number, h: number, cutoff = 200): void {
  const id = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < id.data.length; i += 4) {
    const lum = 0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2];
    const v = lum < cutoff ? 0 : 255;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
}

// ─── Templates ────────────────────────────────────────────────────────────────

/** The item tag: barcode, SKU, price, name. The barcode is the item's identity. */
export function drawItemTag(ctx: SKRSContext2D, W: number, H: number, item: ItemLabelData): void {
  const CX = W / 2;
  const halfH = Math.floor(H / 2);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';

  const modules = code128BModules(item.sku);
  const moduleW = 2;
  let col = Math.floor(CX - (modules.length * moduleW) / 2);
  for (const black of modules) {
    if (col >= 0 && col + moduleW <= W && black) ctx.fillRect(col, 0, moduleW, 64);
    col += moduleW;
  }

  ctx.font = labelFont(16, 'bold');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(item.sku, CX, halfH - 10);

  ctx.fillRect(0, halfH, W, 1);

  // Baselines counted down from the divider rather than as fractions of the
  // lower half, so a tag rendered here lands on the same rows as one from the
  // iPad. With symmetric top and bottom margins the two coordinate systems —
  // this content box, and the iPad's full-head grid — agree on where halfH is.
  ctx.font = labelFont(44, 'bold');
  ctx.fillText(`$${(item.priceCents / 100).toFixed(2)}`, CX, halfH + 60);

  // Fitted, not truncated: at 24 a long name would run into the branding strip,
  // and 15 — the size this used to be fixed at — is the floor, so nothing gets
  // smaller than it was, only bigger when there is room.
  ctx.fillText(fitted(ctx, item.name, 24, 15, W), CX, halfH + 90);
}

/** Sticks on the printer itself so staff can tell one from another. */
export function drawPrinterLabel(
  ctx: SKRSContext2D, W: number, H: number, printerName: string, orgName: string,
): void {
  const CX = W / 2;
  const y = (frac: number) => Math.floor(H * frac);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const yPrinterName = y(0.16);
  const yOrgName = y(0.6);

  ctx.font = labelFont(20);
  ctx.fillText('Hi! My name is:', CX, yPrinterName - 20);
  ctx.font = labelFont(38, 'bold');
  ctx.fillText(fit(ctx, printerName, W), CX, yPrinterName);
  ctx.font = labelFont(20);
  ctx.fillText('I belong to:', CX, yOrgName - 20);
  ctx.font = labelFont(28, 'bold');
  ctx.fillText(fit(ctx, orgName, W), CX, yOrgName);
}

/** First label of a receipt: who, when, and a QR to their item-status page. */
export async function drawReceiptHeader(
  ctx: SKRSContext2D, W: number, H: number, data: ReceiptHeaderData,
): Promise<void> {
  const halfH = Math.floor(H / 2);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  const LOGO_SIZE = 64;
  if (data.orgLogoUrl) {
    try {
      const logo = await loadImage(data.orgLogoUrl);
      const oc = createCanvas(LOGO_SIZE, LOGO_SIZE);
      const og = oc.getContext('2d');
      og.fillStyle = '#fff';
      og.fillRect(0, 0, LOGO_SIZE, LOGO_SIZE);
      og.drawImage(logo, 0, 0, LOGO_SIZE, LOGO_SIZE);
      threshold(og, LOGO_SIZE, LOGO_SIZE);
      ctx.drawImage(oc, 0, Math.floor((halfH - LOGO_SIZE) / 2), LOGO_SIZE, LOGO_SIZE);
    } catch {
      // A missing or unreadable org logo must never fail a receipt.
    }
  }

  const DATE_H = 20, PHONE_H = 20, LINE_GAP = 2;
  // The block sits to the right of the logo, so that is the width the name has
  // to live in. Bounded rather than given the full column: at 26 a long name
  // set across the whole width would run over the org's mark.
  const NAME_H = fitSize(ctx, data.sellerName, 26, 12, W - (LOGO_SIZE + 8));

  const blockH = lineHeight(DATE_H) + lineHeight(NAME_H) + lineHeight(PHONE_H) + LINE_GAP * 2;
  let ty = Math.floor((halfH - blockH) / 2);
  ctx.textAlign = 'right';
  ctx.font = labelFont(DATE_H, 'bold');
  ctx.fillText(data.date, W, ty);
  ty += lineHeight(DATE_H) + LINE_GAP;
  ctx.font = labelFont(NAME_H, 'bold');
  ctx.fillText(fit(ctx, data.sellerName, W - (LOGO_SIZE + 8)), W, ty);
  ty += lineHeight(NAME_H) + LINE_GAP;
  ctx.font = labelFont(PHONE_H, 'bold');
  ctx.fillText(data.phone, W, ty);

  ctx.fillRect(0, halfH, W, 1);

  const bottomAvail = H - halfH - 1;
  const QR_SIZE = Math.min(96, bottomAvail - 8);
  const QR_X = W - QR_SIZE - 8;
  drawQr(ctx, data.qrUrl, QR_X, halfH + 1 + Math.floor((bottomAvail - QR_SIZE) / 2), QR_SIZE);

  // One sentence over two lines, so one size for both — the larger of the two
  // strings decides it. Centred in the column left of the QR rather than pushed
  // against the margin, which is where the type is now big enough to matter.
  const SCAN_GAP = 4;
  const scanAreaW = QR_X - 8;
  const SCAN_SIZE = commonFitSize(ctx, ['Scan to track', 'your items:'], 30, 12, scanAreaW);
  const scanY = halfH + 1 + Math.floor((bottomAvail - (lineHeight(SCAN_SIZE) * 2 + SCAN_GAP)) / 2);
  ctx.fillStyle = '#000';
  ctx.font = labelFont(SCAN_SIZE, 'bold');
  ctx.textAlign = 'center';
  ctx.fillText('Scan to track', Math.floor(scanAreaW / 2), scanY);
  ctx.fillText('your items:', Math.floor(scanAreaW / 2), scanY + lineHeight(SCAN_SIZE) + SCAN_GAP);
}

/**
 * Continuation labels listing items. Returns how many fitted, so the caller can
 * paginate — the item list is unbounded and a label is 224 dots tall.
 */
export function drawReceiptItems(
  ctx: SKRSContext2D, W: number, H: number,
  items: { name: string; sku: string; priceCents: number }[],
  showHeader: boolean,
): { rowsDrawn: number } {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  const NAME_H = 24, SKU_H = 18, HEADER_H = 20, LINE_GAP = 2, ITEM_GAP = 4;
  const itemH = lineHeight(NAME_H) + LINE_GAP + lineHeight(SKU_H);
  let y = 0;

  if (showHeader) {
    ctx.font = labelFont(HEADER_H, 'bold');
    ctx.textAlign = 'center';
    ctx.fillText('Your Items:', W / 2, y);
    y += lineHeight(HEADER_H) + 6;
  }

  let drawn = 0;
  for (const item of items) {
    if ((drawn > 0 ? y + ITEM_GAP : y) + itemH > H) break;
    if (drawn > 0) y += ITEM_GAP;

    const priceStr = `$${(item.priceCents / 100).toFixed(2)}`;
    ctx.font = labelFont(NAME_H, 'bold');
    const priceW = ctx.measureText(priceStr).width;

    // The name takes whatever the price leaves, and shrinks to stay inside it
    // rather than being cut — the amount owed is the one thing on this line
    // that must never be crowded.
    ctx.textAlign = 'left';
    ctx.fillText(fitted(ctx, item.name, NAME_H, 12, W - priceW - 8), 0, y);
    ctx.textAlign = 'right';
    ctx.font = labelFont(NAME_H, 'bold');
    ctx.fillText(priceStr, W, y);
    y += lineHeight(NAME_H) + LINE_GAP;

    ctx.font = labelFont(SKU_H, 'bold');
    ctx.textAlign = 'left';
    ctx.fillText(item.sku, 4, y);
    y += lineHeight(SKU_H);
    drawn++;
  }

  return { rowsDrawn: drawn };
}

/** A seller's personal QR, printed so they can check item status later. */
export function drawQrLabel(
  ctx: SKRSContext2D, W: number, H: number, sellerName: string, url: string,
): void {
  const CX = W / 2;
  const y = (frac: number) => Math.floor(H * frac);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  ctx.font = labelFont(14, 'bold');
  ctx.fillText('Scan this code to track', CX, y(0), W);
  ctx.fillText('the status of your items:', CX, y(0.065), W);

  const QR_SIZE = Math.min(144, W);
  const QR_TOP = y(0.155);
  drawQr(ctx, url, Math.round(CX - QR_SIZE / 2), QR_TOP, QR_SIZE);

  ctx.fillStyle = '#000';
  ctx.font = labelFont(13, 'bold');
  ctx.fillText(fit(ctx, sellerName, W), CX, QR_TOP + QR_SIZE + 4, W);
}

/** "Powered by PatrolKit", rotated up the right margin, reading bottom-to-top. */
export async function drawRotatedBranding(
  ctx: SKRSContext2D, W: number, H: number, margins: PrinterMargins,
): Promise<void> {
  // PB_SLOT is the strip column the logo block starts after, and is what
  // BRANDING_STRIP_W is built from (11 + 2 + 16). PB_SIZE is the type set in
  // that slot, which is smaller than the slot — so shrinking the words does not
  // move the mark below them.
  const LOGO_SIZE = 16, LOGO_TEXT_SIZE = 11, GAP = 4, PB_SLOT = 11, PB_SIZE = 9;

  ctx.save();
  ctx.translate(W - margins.marginRight - BRANDING_STRIP_W / 2, H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const poweredByRY = -BRANDING_STRIP_W / 2;
  const logoRY = poweredByRY + PB_SLOT + 2;

  ctx.font = labelFont(PB_SIZE, 'bold');
  ctx.fillStyle = '#555';
  ctx.fillText('Powered by', 0, poweredByRY);

  ctx.font = labelFont(LOGO_TEXT_SIZE, 'bold');
  ctx.fillStyle = '#000';
  const blockW = LOGO_SIZE + GAP + ctx.measureText('PatrolKit').width;
  const logoRX = -blockW / 2;

  ctx.drawImage(await getBrandMark(), logoRX, logoRY, LOGO_SIZE, LOGO_SIZE);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#000';
  ctx.fillText('PatrolKit', logoRX + LOGO_SIZE + GAP, logoRY + (LOGO_SIZE - LOGO_TEXT_SIZE) / 2);
  ctx.restore();
}

/**
 * Alignment pattern: full-canvas diagonals, the margin box, and a crosshair.
 * Built as a raster directly — there is no text, so no canvas is needed.
 */
export function calibrationPattern(paperSize: PaperSize, margins: PrinterMargins): boolean[][] {
  const W = HEAD_WIDTH_DOTS;
  const H = PAPER_SIZE_HEIGHT_DOTS[paperSize];
  const rows: boolean[][] = Array.from({ length: H }, () => new Array<boolean>(W).fill(false));
  const D = 2;

  const L = margins.marginLeft;
  const R = W - margins.marginRight;
  const T = margins.marginTop;
  const B = H - margins.marginBottom;
  const CX = Math.round((L + R - D) / 2);
  const CY = Math.round((T + B - D) / 2);

  const hline = (y: number, x0: number, x1: number) => {
    for (let d = 0; d < D; d++) if (y + d < H) for (let x = x0; x < x1; x++) rows[y + d][x] = true;
  };
  const vline = (x: number, y0: number, y1: number) => {
    for (let d = 0; d < D; d++) if (x + d < W) for (let y = y0; y < y1; y++) rows[y][x + d] = true;
  };

  for (let y = 0; y < H; y++) {
    const x1 = Math.round((y * (W - 1)) / (H - 1));
    const x2 = W - 1 - x1;
    if (x1 < W) rows[y][x1] = true;
    if (x1 + 1 < W) rows[y][x1 + 1] = true;
    if (x2 >= 0) rows[y][x2] = true;
    if (x2 - 1 >= 0) rows[y][x2 - 1] = true;
  }

  hline(T, L, R);
  hline(B - D, L, R);
  vline(L, T, B);
  vline(R - D, T, B);
  hline(CY, L, R);
  vline(CX, T, B);

  return rows;
}
