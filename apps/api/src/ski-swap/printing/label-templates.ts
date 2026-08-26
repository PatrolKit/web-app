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

  ctx.font = labelFont(16);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(item.sku, CX, halfH - 10);

  ctx.fillRect(0, halfH, W, 1);

  const bottomH = H - halfH;
  ctx.font = labelFont(44, 'bold');
  ctx.fillText(`$${(item.priceCents / 100).toFixed(2)}`, CX, halfH + Math.floor(bottomH * 0.55));

  ctx.font = labelFont(15);
  ctx.fillText(fit(ctx, item.name, W), CX, halfH + Math.floor(bottomH * 0.82));
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

  const DATE_H = 16, NAME_H = 18, PHONE_H = 16, LINE_GAP = 3;
  let ty = Math.floor((halfH - (DATE_H + NAME_H + PHONE_H + LINE_GAP * 2)) / 2);
  ctx.textAlign = 'right';
  ctx.font = labelFont(DATE_H, 'bold');
  ctx.fillText(data.date, W, ty);
  ty += DATE_H + LINE_GAP;
  ctx.font = labelFont(NAME_H, 'bold');
  ctx.fillText(fit(ctx, data.sellerName, W), W, ty);
  ty += NAME_H + LINE_GAP;
  ctx.font = labelFont(PHONE_H, 'bold');
  ctx.fillText(data.phone, W, ty);

  ctx.fillRect(0, halfH, W, 1);

  const bottomAvail = H - halfH - 1;
  const QR_SIZE = Math.min(96, bottomAvail - 8);
  const QR_X = W - QR_SIZE - 8;
  drawQr(ctx, data.qrUrl, QR_X, halfH + 1 + Math.floor((bottomAvail - QR_SIZE) / 2), QR_SIZE);

  const SCAN_SIZE = 14, SCAN_GAP = 3;
  const scanY = halfH + 1 + Math.floor((bottomAvail - (SCAN_SIZE * 2 + SCAN_GAP)) / 2);
  ctx.fillStyle = '#000';
  ctx.font = labelFont(SCAN_SIZE, 'bold');
  ctx.textAlign = 'left';
  ctx.fillText('Scan to track', 0, scanY, QR_X - 4);
  ctx.fillText('your items:', 0, scanY + SCAN_SIZE + SCAN_GAP, QR_X - 4);
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

  const NAME_H = 18, SKU_H = 14, LINE_GAP = 2, ITEM_GAP = 4;
  const itemH = NAME_H + LINE_GAP + SKU_H;
  let y = 0;

  if (showHeader) {
    ctx.font = labelFont(16, 'bold');
    ctx.textAlign = 'center';
    ctx.fillText('Your Items:', W / 2, y);
    y += 22;
  }

  let drawn = 0;
  for (const item of items) {
    if ((drawn > 0 ? y + ITEM_GAP : y) + itemH > H) break;
    if (drawn > 0) y += ITEM_GAP;

    const priceStr = `$${(item.priceCents / 100).toFixed(2)}`;
    ctx.font = labelFont(NAME_H, 'bold');
    const priceW = ctx.measureText(priceStr).width;

    ctx.textAlign = 'left';
    ctx.fillText(fit(ctx, item.name, W - priceW - 4), 0, y);
    ctx.textAlign = 'right';
    ctx.fillText(priceStr, W, y);
    y += NAME_H + LINE_GAP;

    ctx.font = labelFont(SKU_H, 'bold');
    ctx.textAlign = 'left';
    ctx.fillText(item.sku, 4, y);
    y += SKU_H;
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
  const LOGO_SIZE = 16, LOGO_TEXT_SIZE = 11, GAP = 4, PB_SIZE = 11;

  ctx.save();
  ctx.translate(W - margins.marginRight - BRANDING_STRIP_W / 2, H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const poweredByRY = -BRANDING_STRIP_W / 2;
  const logoRY = poweredByRY + PB_SIZE + 2;

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
