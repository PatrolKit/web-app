import { createCanvas, loadImage, type SKRSContext2D, type Image } from '@napi-rs/canvas';
import QRCode from 'qrcode';
import { code128BModules } from './code128.util';
import { labelFont } from './fonts';
import { BRAND_MARK_PNG } from './brand-mark';
import {
  BRANDING_STRIP_W,
  geometryOf,
  type PrintTarget,
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
 * How much larger type should be on this canvas than on a compact tag.
 *
 * The receipt, the printer sticker and the seller QR are the same composition
 * whatever they are printed on — unlike the item tag, nothing has specified a
 * different arrangement for a bigger label — so they scale rather than getting a
 * tier of their own. Only the type sizes were fixed in dots; the layouts were
 * already fractions of the canvas.
 *
 * Referenced to the compact content box, and floored at 1, so a 50 × 30 label
 * comes out byte-for-byte as before and only a larger one changes.
 */
const COMPACT_CONTENT_W = 339;

function typeScale(W: number): number {
  return Math.max(1, W / COMPACT_CONTENT_W);
}

/**
 * Breaks `text` into at most `maxLines` lines that each fit `maxWidth`.
 *
 * New for the tall tag, which is the first layout with a column too narrow to
 * hold a name on one line. The two existing strategies do not apply: `fit`
 * truncates, which loses most of a long name rather than a couple of characters,
 * and `fitted` shrinks, which on a 22 mm column reaches the floor while still
 * overflowing.
 *
 * Breaks on spaces, and falls back to breaking inside a word only when a single
 * word does not fit — a ski model number with no spaces in it would otherwise
 * produce an empty line and loop. The last line is ellipsised if anything is
 * left over, so the overflow is visible rather than silent.
 */
function wrap(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';

  const flush = () => { if (line) { lines.push(line); line = ''; } };

  for (let i = 0; i < words.length && lines.length < maxLines; i++) {
    const word = words[i];
    const candidate = line ? `${line} ${word}` : word;

    if (ctx.measureText(candidate).width <= maxWidth) { line = candidate; continue; }

    flush();
    if (lines.length >= maxLines) break;

    // A word wider than the column on its own: cut it rather than loop.
    if (ctx.measureText(word).width > maxWidth) {
      let head = word;
      while (head.length > 1 && ctx.measureText(head).width > maxWidth) head = head.slice(0, -1);
      lines.push(head);
      words[i] = word.slice(head.length);
      i--; // the remainder goes on the next line
    } else {
      line = word;
    }
  }
  flush();

  // Anything left unplaced is said rather than dropped.
  const placed = lines.join(' ').replace(/\s+/g, ' ').trim();
  const wanted = text.replace(/\s+/g, ' ').trim();
  if (lines.length === maxLines && placed.length < wanted.length) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = fit(ctx, `${last}…`, maxWidth);
  }
  return lines;
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

/**
 * The 62 × 100 mm tag: price and name rotated up the label, barcode and SKU
 * across the foot, branding beside the barcode.
 *
 * A different composition from `drawItemTag` rather than the same one enlarged.
 * Price and name are rotated because the name column is about 22 mm wide and no
 * useful text runs across 22 mm — and once one is rotated the other has to be,
 * or the tag reads as two unrelated halves.
 *
 * Branding is drawn here rather than by the compositor. On the compact tier it
 * is a strip parked against the right inset; here it belongs in the foot beside
 * the barcode, so `compose` hands this template the whole content box.
 */
export async function drawLargeItemTag(
  ctx: SKRSContext2D, W: number, H: number, item: ItemLabelData,
): Promise<void> {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';

  // ── Proportions ───────────────────────────────────────────────────────────
  // Fractions rather than dots, so a second size in this tier costs nothing.
  const GAP = Math.round(W * 0.03);
  const footH = Math.round(H * 0.30);
  const upperH = H - footH - GAP;
  const nameColW = Math.round(W * 0.26);
  const priceColW = W - nameColW - GAP;
  const brandColW = Math.round(W * 0.20);
  const barcodeW = W - brandColW - GAP;

  // ── Price, rotated up its column ──────────────────────────────────────────
  const price = `$${(item.priceCents / 100).toFixed(2)}`;
  ctx.save();
  ctx.translate(priceColW / 2, upperH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Rotated, so the price reads along the column's *height* and is limited by
  // its width. Ceiling is far above the compact tag's 44 — that tag was bounded
  // by a 30 mm label, and this one is not.
  ctx.font = labelFont(fitSize(ctx, price, 150, 40, upperH - GAP), 'bold');
  ctx.fillText(price, 0, 0);
  ctx.restore();

  // ── Name, rotated up the narrow column ────────────────────────────────────
  const NAME_SIZE = Math.round(W * 0.055);
  const NAME_LINES = 3;
  ctx.font = labelFont(NAME_SIZE, 'bold');
  const nameLines = wrap(ctx, item.name, upperH - GAP, NAME_LINES);

  ctx.save();
  ctx.translate(priceColW + GAP + nameColW / 2, upperH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const nameLead = lineHeight(NAME_SIZE);
  const nameTop = -((nameLines.length - 1) * nameLead) / 2;
  nameLines.forEach((line, i) => ctx.fillText(line, 0, nameTop + i * nameLead));
  ctx.restore();

  // ── Barcode ───────────────────────────────────────────────────────────────
  const footTop = upperH + GAP;
  const SKU_SIZE = Math.round(W * 0.05);
  const skuBand = lineHeight(SKU_SIZE) + GAP;
  const barsH = footH - skuBand;

  const modules = code128BModules(item.sku);
  // Wider bars than the compact tag's 2, which is the point of the bigger label
  // — but never wider than the column, so a long SKU narrows rather than runs
  // off the edge.
  const moduleW = Math.max(1, Math.min(3, Math.floor(barcodeW / modules.length)));
  const barsW = modules.length * moduleW;
  let col = Math.round((barcodeW - barsW) / 2);
  for (const black of modules) {
    if (black) ctx.fillRect(col, footTop, moduleW, barsH);
    col += moduleW;
  }

  // ── SKU, human-readable under the bars ────────────────────────────────────
  ctx.font = labelFont(SKU_SIZE, 'bold');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(item.sku, barcodeW / 2, footTop + barsH + GAP);

  // ── Branding, rotated in the foot's right column ──────────────────────────
  await drawBrandingIn(ctx, barcodeW + GAP, footTop, brandColW, footH);
}

/**
 * "Powered by PatrolKit" rotated inside an explicit box.
 *
 * `drawRotatedBranding` derives its position from the right margin, which is
 * right for the compact tier — the strip sits on the inset boundary and moves
 * inward with it. The tall tag puts branding in the foot instead, so it needs to
 * be told where to go.
 */
async function drawBrandingIn(
  ctx: SKRSContext2D, x: number, y: number, w: number, h: number,
): Promise<void> {
  const LOGO = Math.round(w * 0.42), TEXT = Math.round(w * 0.30), PB = Math.round(w * 0.24);
  const GAP = Math.max(2, Math.round(w * 0.08));

  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = labelFont(PB, 'bold');
  ctx.fillStyle = '#555';
  ctx.fillText('Powered by', 0, -w / 2 + PB);

  ctx.font = labelFont(TEXT, 'bold');
  ctx.fillStyle = '#000';
  const blockW = LOGO + GAP + ctx.measureText('PatrolKit').width;
  const left = -blockW / 2;
  const logoY = -w / 2 + PB + GAP + LOGO / 2;

  ctx.drawImage(await getBrandMark(), left, logoY - LOGO / 2, LOGO, LOGO);
  ctx.textAlign = 'left';
  ctx.fillText('PatrolKit', left + LOGO + GAP, logoY);
  ctx.restore();
}

/** Sticks on the printer itself so staff can tell one from another. */
export function drawPrinterLabel(
  ctx: SKRSContext2D, W: number, H: number, printerName: string, orgName: string,
): void {
  const CX = W / 2;
  const y = (frac: number) => Math.floor(H * frac);
  const k = typeScale(W);
  const CAPTION = Math.round(20 * k);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const yPrinterName = y(0.16);
  const yOrgName = y(0.6);

  ctx.font = labelFont(CAPTION);
  ctx.fillText('Hi! My name is:', CX, yPrinterName - CAPTION);
  ctx.font = labelFont(Math.round(38 * k), 'bold');
  ctx.fillText(fit(ctx, printerName, W), CX, yPrinterName);
  ctx.font = labelFont(CAPTION);
  ctx.fillText('I belong to:', CX, yOrgName - CAPTION);
  ctx.font = labelFont(Math.round(28 * k), 'bold');
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

  const k = typeScale(W);
  const LOGO_SIZE = Math.round(64 * k);
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

  const DATE_H = Math.round(20 * k), PHONE_H = Math.round(20 * k), LINE_GAP = 2;
  // The block sits to the right of the logo, so that is the width the name has
  // to live in. Bounded rather than given the full column: at 26 a long name
  // set across the whole width would run over the org's mark.
  const NAME_H = fitSize(ctx, data.sellerName, Math.round(26 * k), 12, W - (LOGO_SIZE + 8));

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
  // Bounded by the space below the rule, so a taller label gets a bigger code
  // rather than the same one adrift in white.
  const QR_SIZE = Math.min(Math.round(96 * k), bottomAvail - 8);
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

  const k = typeScale(W);
  const NAME_H = Math.round(24 * k), SKU_H = Math.round(18 * k);
  const HEADER_H = Math.round(20 * k), LINE_GAP = 2, ITEM_GAP = 4;
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

  const k = typeScale(W);
  ctx.font = labelFont(Math.round(14 * k), 'bold');
  ctx.fillText('Scan this code to track', CX, y(0), W);
  ctx.fillText('the status of your items:', CX, y(0.065), W);

  const QR_SIZE = Math.min(Math.round(144 * k), W);
  const QR_TOP = y(0.155);
  drawQr(ctx, url, Math.round(CX - QR_SIZE / 2), QR_TOP, QR_SIZE);

  ctx.fillStyle = '#000';
  ctx.font = labelFont(Math.round(13 * k), 'bold');
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
export function calibrationPattern(target: PrintTarget): boolean[][] {
  const { margins } = target;
  const { headWidthDots: W, mediaWidthDots, mediaOffsetDots, canvasHeightDots: H } =
    geometryOf(target);
  const rows: boolean[][] = Array.from({ length: H }, () => new Array<boolean>(W).fill(false));
  const D = 2;

  // The margin rectangle is drawn on the media, not on the head — that is the
  // whole point of printing one. Where the diagonals cross is the head's centre,
  // and where the full-width box is clipped is the head's real edge, so a single
  // label answers both "how wide is the head" and "do the margins hold".
  const L = mediaOffsetDots + margins.marginLeft;
  const R = mediaOffsetDots + mediaWidthDots - margins.marginRight;
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
