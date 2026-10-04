import { createCanvas, loadImage, type SKRSContext2D, type Image } from '@napi-rs/canvas';
import QRCode from 'qrcode';
import { code128BModules } from './code128.util';
import { stationCodeOf } from '../sku.util';
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
  /** The status page the QR opens; null for no QR (Plan 36). */
  qrUrl: string | null;
  /** The two lines beside the QR; "Scan to track / your items:" when absent. */
  qrCaption?: [string, string];
  /** Said where the QR would be when there's none and nothing else to show. */
  note?: string;
}

/** Which columns a receipt's lines show (Plan 36). The name, or else the SKU, leads. */
export interface ReceiptColumns {
  sku: boolean;
  name: boolean;
  price: boolean;
}

export const ALL_COLUMNS: ReceiptColumns = { sku: true, name: true, price: true };

/** A line's leading text and its second line, per the columns shown. */
function lineText(item: ReceiptItemLine, show: ReceiptColumns): { lead: string; second: string | null } {
  return show.name
    ? { lead: item.name, second: show.sku ? item.sku : null }
    : { lead: item.sku, second: null };
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
function wrap(
  ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number,
): { lines: string[]; truncated: boolean } {
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
  const truncated = lines.length === maxLines && placed.length < wanted.length;
  if (truncated) {
    lines[maxLines - 1] = fit(ctx, `${lines[maxLines - 1]}…`, maxWidth);
  }
  return { lines, truncated };
}

/**
 * The largest size at which `text` fits `maxLines` without losing any of it.
 *
 * `fitted` shrinks one line until it fits; this shrinks until the *wrap* fits,
 * which is a different question — a name too long for one line at 40 may be
 * perfectly comfortable on two. Stepping down only when something would
 * actually be cut is what lets a short name be set large and a long one still
 * be set whole.
 *
 * Falls back to `minSize` and whatever that holds, ellipsis included, for a name
 * no size can accommodate.
 */
function fitWrapped(
  ctx: SKRSContext2D, text: string, preferred: number, minSize: number,
  maxWidth: number, maxLines: number,
): { size: number; lines: string[] } {
  for (let size = preferred; size > minSize; size -= 2) {
    ctx.font = labelFont(size, 'bold');
    const { lines, truncated } = wrap(ctx, text, maxWidth, maxLines);
    if (!truncated) return { size, lines };
  }
  ctx.font = labelFont(minSize, 'bold');
  return { size: minSize, lines: wrap(ctx, text, maxWidth, maxLines).lines };
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

  // The station's letter, beside the price and clear of the name below it.
  // The widest price the tag prints is a little over 200 dots, which leaves
  // more than this square either side of it.
  const letter = stationCodeOf(item.sku);
  if (letter) drawStationBadge(ctx, 0, halfH + 22, COMPACT_BADGE, letter);
}

/** The station badge on the compact tag, in dots. */
const COMPACT_BADGE = 38;

/**
 * The station's letter, reversed out of a filled square (Plan 27).
 *
 * Several counters can print to one bridge, and a tag says nothing else about
 * where it came from. The letter is already in the SKU, but as one character in
 * the middle of a number; this is the same letter, big enough to sort a pile of
 * tags by at arm's length.
 */
function drawStationBadge(
  ctx: SKRSContext2D, x: number, y: number, size: number, letter: string, rotation = 0,
): void {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, size, size);
  ctx.translate(x + size / 2, y + size / 2);
  ctx.rotate(rotation);
  ctx.fillStyle = '#fff';
  ctx.font = labelFont(Math.round(size * 0.78), 'bold');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, 0, 1);
  ctx.restore();
}

/**
 * Quarter turn clockwise, so rotated text reads top-to-bottom.
 *
 * Every rotated element on this tag shares it, which is the point: composing a
 * block in the rotated frame and flipping this sign turns that whole block 180°
 * about its own centre, so the three of them cannot drift out of agreement.
 *
 * The compact tier reads the other way (`drawRotatedBranding`) and stays that
 * way — its strip runs up the side of a 30 mm label, where there is no tag to
 * hold and nothing to be upside-down relative to.
 */
const ROTATION = Math.PI / 2;

/**
 * The 62 × 100 mm tag: price and name rotated down the label, barcode and SKU
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
  // The name column is wide enough to be the thing that stops the name growing,
  // and no wider. Rotated, its width caps the type — two lines at 1.2 leading —
  // so 0.26 held the name to 50 while the price column kept 329 dots for a line
  // box of about 180. That slack was doing nothing; moved here it buys 69, and
  // the price still has room for far more than its 150 ceiling.
  const nameColW = Math.round(W * 0.36);
  const priceColW = W - nameColW - GAP;
  const brandColW = Math.round(W * 0.20);
  const barcodeW = W - brandColW - GAP;
  const SKU_SIZE = Math.round(W * 0.05);

  // The bars are sized from their own width, not from whatever the foot has
  // left over. A Code 128 symbol wants a height of roughly 15% of its length —
  // this allows double that, which is generous for a handheld scanner reading a
  // swinging tag, and floors at the 64 rows the compact tag uses so a short SKU
  // never produces a stripe too shallow to aim at. Sized the other way round it
  // came out 59% and ate a third of the label.
  const modules = code128BModules(item.sku);
  const moduleW = Math.max(1, Math.min(3, Math.floor(barcodeW / modules.length)));
  const barsW = modules.length * moduleW;
  const barsH = Math.max(64, Math.round(barsW * 0.30));

  // The foot is as tall as the bars and their number, and the label's remaining
  // height is the price's.
  const footH = barsH + GAP + lineHeight(SKU_SIZE);
  const upperH = H - footH - GAP;

  // ── Price, rotated up its column ──────────────────────────────────────────
  const price = `$${(item.priceCents / 100).toFixed(2)}`;
  ctx.save();
  ctx.translate(priceColW / 2, upperH / 2);
  ctx.rotate(ROTATION);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Rotated, so the price reads along the column's *height* and is limited by
  // its width. Ceiling is far above the compact tag's 44 — that tag was bounded
  // by a 30 mm label, and this one is not.
  ctx.font = labelFont(fitSize(ctx, price, 150, 40, upperH - GAP), 'bold');
  ctx.fillText(price, 0, 0);
  ctx.restore();

  // ── Name, rotated up the narrow column ────────────────────────────────────
  //
  // Rotated, so the lines stack across the column's *width* and each line runs
  // along its depth. Two lines rather than three, and sized to fill what that
  // leaves: at three the type was a fixed 26 and used three quarters of the
  // column, which read small on a label this size for no reason.
  const NAME_LINES = 2;
  const nameMax = Math.floor(nameColW / (NAME_LINES * 1.2));
  const { size: NAME_SIZE, lines: nameLines } =
    fitWrapped(ctx, item.name, nameMax, 14, upperH - GAP, NAME_LINES);

  ctx.save();
  ctx.translate(priceColW + GAP + nameColW / 2, upperH / 2);
  ctx.rotate(ROTATION);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const nameLead = lineHeight(NAME_SIZE);
  const nameTop = -((nameLines.length - 1) * nameLead) / 2;
  nameLines.forEach((line, i) => ctx.fillText(line, 0, nameTop + i * nameLead));
  ctx.restore();

  // ── Barcode ───────────────────────────────────────────────────────────────
  // Bars up to 3 dots wide, against the compact tag's 2 — the point of the
  // bigger label — but never wider than the column, so a long SKU narrows
  // rather than running off the edge.
  const footTop = upperH + GAP;
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

  // ── Station letter, at the head of the price column ───────────────────────
  // In the corner the rotated price leaves empty — the price is centred in a
  // column far wider than its type is tall — and turned with it, so the letter
  // reads upright alongside the price and comes before it.
  const letter = stationCodeOf(item.sku);
  if (letter) drawStationBadge(ctx, 0, 0, Math.round(W * 0.13), letter, ROTATION);

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
  const PB = Math.round(w * 0.24);
  const GAP = Math.max(2, Math.round(w * 0.08));

  // The mark and the words run along the box's *length*, so they are bounded by
  // `h` rather than by `w`. Fitted rather than assumed: the foot is now only as
  // tall as the barcode needs, so this box is short, and a fixed size ran the
  // words out the end of it.
  let LOGO = Math.round(w * 0.42);
  let TEXT = Math.round(w * 0.30);
  ctx.font = labelFont(TEXT, 'bold');
  while (TEXT > 7 && LOGO + GAP + ctx.measureText('PatrolKit').width > h) {
    TEXT -= 1;
    LOGO = Math.min(LOGO, Math.round(TEXT * 1.4));
    ctx.font = labelFont(TEXT, 'bold');
  }

  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(ROTATION);
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

  // The date carries its zone now, so it shrinks rather than reach the logo.
  const DATE_H = fitSize(ctx, data.date, Math.round(20 * k), 12, W - (LOGO_SIZE + 8));
  const PHONE_H = Math.round(20 * k), LINE_GAP = 2;
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

  // No link, no code (Plan 36): the half below the rule says the note, if any.
  if (!data.qrUrl) {
    if (data.note) {
      const NOTE = fitSize(ctx, data.note, Math.round(22 * k), 12, W - 8);
      ctx.font = labelFont(NOTE, 'bold');
      ctx.textAlign = 'center';
      ctx.fillText(data.note, Math.floor(W / 2), halfH + 1 + Math.floor((bottomAvail - lineHeight(NOTE)) / 2));
    }
    return;
  }

  // Bounded by the space below the rule, so a taller label gets a bigger code
  // rather than the same one adrift in white.
  const QR_SIZE = Math.min(Math.round(96 * k), bottomAvail - 8);
  const QR_X = W - QR_SIZE - 8;
  drawQr(ctx, data.qrUrl, QR_X, halfH + 1 + Math.floor((bottomAvail - QR_SIZE) / 2), QR_SIZE);

  // One sentence over two lines, so one size for both — the larger of the two
  // strings decides it. Centred in the column left of the QR rather than pushed
  // against the margin, which is where the type is now big enough to matter.
  const [scanA, scanB] = data.qrCaption ?? ['Scan to track', 'your items:'];
  const SCAN_GAP = 4;
  const scanAreaW = QR_X - 8;
  const SCAN_SIZE = commonFitSize(ctx, [scanA, scanB], 30, 12, scanAreaW);
  const scanY = halfH + 1 + Math.floor((bottomAvail - (lineHeight(SCAN_SIZE) * 2 + SCAN_GAP)) / 2);
  ctx.fillStyle = '#000';
  ctx.font = labelFont(SCAN_SIZE, 'bold');
  ctx.textAlign = 'center';
  ctx.fillText(scanA, Math.floor(scanAreaW / 2), scanY);
  ctx.fillText(scanB, Math.floor(scanAreaW / 2), scanY + lineHeight(SCAN_SIZE) + SCAN_GAP);
}

/**
 * Continuation labels listing items. Returns how many fitted, so the caller can
 * paginate — the item list is unbounded and a label is 224 dots tall.
 */
export function drawReceiptItems(
  ctx: SKRSContext2D, W: number, H: number,
  items: ReceiptItemLine[],
  showHeader: boolean,
  show: ReceiptColumns = ALL_COLUMNS,
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

    const priceStr = show.price ? receiptLinePrice(item.priceCents) : '';
    const { lead, second } = lineText(item, show);
    ctx.font = labelFont(NAME_H, 'bold');
    const priceW = priceStr ? ctx.measureText(priceStr).width + 8 : 0;

    // The name takes whatever the price leaves, and shrinks to stay inside it
    // rather than being cut — the amount owed is the one thing on this line
    // that must never be crowded.
    ctx.textAlign = 'left';
    ctx.fillText(fitted(ctx, lead, NAME_H, 12, W - priceW), 0, y);
    if (priceStr) {
      ctx.textAlign = 'right';
      ctx.font = labelFont(NAME_H, 'bold');
      ctx.fillText(priceStr, W, y);
    }
    y += lineHeight(NAME_H) + LINE_GAP;

    if (second) {
      ctx.font = labelFont(SKU_H, 'bold');
      ctx.textAlign = 'left';
      ctx.fillText(second, 4, y);
    }
    y += lineHeight(SKU_H);
    drawn++;
  }

  return { rowsDrawn: drawn };
}

export interface ReceiptItemLine {
  name: string;
  sku: string;
  /** Null for a ticket not yet priced (Plan 32). */
  priceCents: number | null;
}

/** A receipt line's price, or "TBD" for a ticket priced after check-in: short enough to sit beside the name. */
export function receiptLinePrice(cents: number | null): string {
  return cents === null ? 'TBD' : `$${(cents / 100).toFixed(2)}`;
}

/**
 * A whole receipt on one page, continuing onto more only when the list warrants.
 *
 * The compact tier has no choice about this: a 50 × 30 label holds a masthead or
 * about three line items, so a receipt there is a header label followed by a
 * strip of item labels, and the seller carries a small paper chain. On 62 × 100
 * that arrangement spent a whole 100 mm page on a logo, a name and a QR, then
 * started the items on a second — two pages for a seller with one pair of skis,
 * neither of them close to full.
 *
 * So the tall tier composes rather than concatenates: masthead, code, list and
 * total on one page, and a second page only once the items genuinely run past
 * the bottom. Roughly seven items fit under the masthead and twelve on a
 * continuation, which covers nearly every seller in one sheet.
 *
 * Takes the items still to be drawn and reports how many it managed, so the
 * caller paginates without this needing to know which page it is beyond whether
 * it is the first.
 */
export async function drawTallReceipt(
  ctx: SKRSContext2D,
  W: number,
  H: number,
  data: ReceiptHeaderData,
  remaining: ReceiptItemLine[],
  /** `totalCents` is of the priced items; `unpricedCount` says how many it leaves out. */
  page: { index: number; itemCount: number; totalCents: number; unpricedCount: number },
  /** The columns shown, and whether the items are listed at all (Plan 36). */
  layout: { show: ReceiptColumns; statusOnly: boolean } = { show: ALL_COLUMNS, statusOnly: false },
): Promise<{ rowsDrawn: number }> {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  // Fractions of the content box rather than dots, like the tall item tag, so a
  // second stock in this tier needs a row in the size table and nothing here.
  const GAP = Math.round(W * 0.03);
  const RULE = Math.max(1, Math.round(W * 0.004));

  let y =
    page.index === 0
      ? await drawReceiptMasthead(ctx, W, GAP, RULE, data, !layout.statusOnly)
      : drawReceiptContinuation(ctx, W, GAP, RULE, data.sellerName);

  // Status page only: the masthead is the receipt (Plan 36). The note says
  // why there's no code, if there's none.
  if (layout.statusOnly) {
    if (!data.qrUrl && data.note) {
      const NOTE = fitSize(ctx, data.note, Math.round(W * 0.05), 12, W);
      ctx.font = labelFont(NOTE, 'bold');
      ctx.textAlign = 'left';
      ctx.fillText(data.note, 0, y);
    }
    return { rowsDrawn: remaining.length };
  }

  // ── The foot is reserved before the list, not after ───────────────────────
  // Every page keeps the same strip free, so how many items fit does not depend
  // on whether this page turns out to be the last — which is not known until
  // the items have been laid out.
  const TOTAL_H = Math.round(W * 0.055);
  const footH = RULE + GAP + lineHeight(TOTAL_H);
  const listBottom = H - footH;

  // ── Line items ────────────────────────────────────────────────────────────
  const NAME_H = Math.round(W * 0.045);
  const SKU_H = Math.round(W * 0.034);
  const ROW_GAP = Math.round(W * 0.018);
  const rowH = lineHeight(NAME_H) + 2 + lineHeight(SKU_H);

  let drawn = 0;
  for (const item of remaining) {
    if ((drawn > 0 ? y + ROW_GAP : y) + rowH > listBottom) break;
    if (drawn > 0) y += ROW_GAP;

    const priceStr = layout.show.price ? receiptLinePrice(item.priceCents) : '';
    const { lead, second } = lineText(item, layout.show);
    ctx.font = labelFont(NAME_H, 'bold');
    const priceW = priceStr ? ctx.measureText(priceStr).width + GAP : 0;

    // The name takes what the price leaves and shrinks to stay inside it rather
    // than being cut: the amount owed is the one thing on the line that must
    // never be crowded.
    ctx.textAlign = 'left';
    ctx.fillText(fitted(ctx, lead, NAME_H, 12, W - priceW), 0, y);
    if (priceStr) {
      ctx.textAlign = 'right';
      ctx.font = labelFont(NAME_H, 'bold');
      ctx.fillText(priceStr, W, y);
    }
    y += lineHeight(NAME_H) + 2;

    if (second) {
      ctx.font = labelFont(SKU_H, 'bold');
      ctx.textAlign = 'left';
      ctx.fillText(second, 0, y);
    }
    y += lineHeight(SKU_H);
    drawn++;
  }

  // ── The foot ──────────────────────────────────────────────────────────────
  ctx.fillRect(0, listBottom, W, RULE);
  const fy = listBottom + RULE + GAP;

  if (drawn === remaining.length) {
    ctx.font = labelFont(TOTAL_H, 'bold');
    ctx.textAlign = 'left';
    ctx.fillText(
      `${page.itemCount} item${page.itemCount === 1 ? '' : 's'}${layout.show.price && page.unpricedCount ? `, ${page.unpricedCount} TBD` : ''}`,
      0, fy,
    );
    // Price off takes the total with it (Plan 36 D7).
    if (layout.show.price) {
      ctx.textAlign = 'right';
      ctx.fillText(`$${(page.totalCents / 100).toFixed(2)}`, W, fy);
    }
  } else {
    // Said on the page rather than left to the seller to work out from a torn
    // edge: they are holding one sheet of two and nothing else says so.
    ctx.font = labelFont(Math.round(W * 0.04), 'bold');
    ctx.textAlign = 'center';
    ctx.fillText('continued on the next page', W / 2, fy);
  }

  return { rowsDrawn: drawn };
}

/** Page one's head: who, when, and the code that tracks their items. */
async function drawReceiptMasthead(
  ctx: SKRSContext2D, W: number, GAP: number, RULE: number, data: ReceiptHeaderData,
  /** False for a status-only receipt, which lists no items (Plan 36). */
  itemsHeading = true,
): Promise<number> {
  const LOGO = Math.round(W * 0.17);
  if (data.orgLogoUrl) {
    try {
      const logo = await loadImage(data.orgLogoUrl);
      const oc = createCanvas(LOGO, LOGO);
      const og = oc.getContext('2d');
      og.fillStyle = '#fff';
      og.fillRect(0, 0, LOGO, LOGO);
      og.drawImage(logo, 0, 0, LOGO, LOGO);
      threshold(og, LOGO, LOGO);
      ctx.drawImage(oc, 0, 0, LOGO, LOGO);
    } catch {
      // A missing or unreadable org logo must never fail a receipt.
    }
  }

  const PHONE_H = Math.round(W * 0.042);
  // Bounded by what the logo leaves, so a long name shrinks rather than running
  // back over the org's mark. The date too, now that it carries its zone.
  const textW = W - LOGO - GAP;
  const DATE_H = fitSize(ctx, data.date, Math.round(W * 0.04), 12, textW);
  const NAME_H = fitSize(ctx, data.sellerName, Math.round(W * 0.075), 14, textW);

  let ty = 0;
  ctx.textAlign = 'right';
  ctx.font = labelFont(DATE_H, 'bold');
  ctx.fillText(data.date, W, ty);
  ty += lineHeight(DATE_H) + 2;
  ctx.font = labelFont(NAME_H, 'bold');
  ctx.fillText(fit(ctx, data.sellerName, textW), W, ty);
  ty += lineHeight(NAME_H) + 2;
  ctx.font = labelFont(PHONE_H, 'bold');
  ctx.fillText(data.phone, W, ty);
  ty += lineHeight(PHONE_H);

  let y = Math.max(LOGO, ty) + GAP;
  ctx.fillRect(0, y, W, RULE);
  y += RULE + GAP;

  // No link, no code and no rule under it (Plan 36).
  if (data.qrUrl) {
    const QR = Math.round(W * 0.30);
    drawQr(ctx, data.qrUrl, W - QR, y, QR);

    const [scanA, scanB] = data.qrCaption ?? ['Scan to track', 'your items:'];
    const scanW = W - QR - GAP;
    const SCAN = commonFitSize(ctx, [scanA, scanB], Math.round(W * 0.062), 12, scanW);
    const scanY = y + Math.floor((QR - (lineHeight(SCAN) * 2 + 4)) / 2);
    ctx.fillStyle = '#000';
    ctx.font = labelFont(SCAN, 'bold');
    ctx.textAlign = 'left';
    ctx.fillText(scanA, 0, scanY);
    ctx.fillText(scanB, 0, scanY + lineHeight(SCAN) + 4);

    y += QR + GAP;
    ctx.fillRect(0, y, W, RULE);
    y += RULE + GAP;
  }

  if (!itemsHeading) return y;

  const HEAD = Math.round(W * 0.042);
  ctx.font = labelFont(HEAD, 'bold');
  ctx.textAlign = 'left';
  ctx.fillText('YOUR ITEMS', 0, y);
  return y + lineHeight(HEAD) + GAP;
}

/** Later pages get a strip naming whose receipt this is, and nothing else. */
function drawReceiptContinuation(
  ctx: SKRSContext2D, W: number, GAP: number, RULE: number, sellerName: string,
): number {
  const CONT = Math.round(W * 0.04);
  ctx.font = labelFont(CONT, 'bold');
  ctx.textAlign = 'right';
  ctx.fillText('continued', W, 0);
  ctx.textAlign = 'left';
  ctx.fillText(fit(ctx, sellerName, W * 0.6), 0, 0);

  const y = lineHeight(CONT) + GAP;
  ctx.fillRect(0, y, W, RULE);
  return y + RULE + GAP;
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

  // Everything here is drawn on the media, never on the head.
  //
  // The diagonals used to span the head, so they ran corner to corner of
  // something the operator cannot see and were cut off by the label's edges part
  // way down. That was deliberate — where they were cut measured the head — but
  // the printer turned out to measure its own head far better: declare more
  // bytes per row than it has and it refuses the raster outright. So the
  // diagonals go back to doing the job somebody holding a label can check, which
  // is whether the geometry lands where it should.
  //
  // Corner to corner of the *media*, so on a correctly placed label they meet
  // its four corners and cross in the middle. Anything else is visible at a
  // glance: a shifted crossing means the media offset is wrong, and diagonals
  // running off an edge mean the label is narrower than the size says.
  const ML = mediaOffsetDots;
  const MR = mediaOffsetDots + mediaWidthDots - 1;
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

  const span = MR - ML;
  for (let y = 0; y < H; y++) {
    const x1 = ML + Math.round((y * span) / (H - 1));
    const x2 = ML + MR - x1;
    for (const x of [x1, x1 + 1, x2, x2 - 1]) {
      if (x >= ML && x <= MR) rows[y][x] = true;
    }
  }

  hline(T, L, R);
  hline(B - D, L, R);
  vline(L, T, B);
  vline(R - D, T, B);
  hline(CY, L, R);
  vline(CX, T, B);

  return rows;
}

// ─── Legacy helper labels (Plan 28) ───────────────────────────────────────────

/**
 * What goes on a legacy ticket's two helper stickers.
 *
 * The iPad works this out (`HelperLabelContent`) and sends it as it is, so a
 * sticker from a bridge says word for word what one from the iPad says.
 */
export interface HelperLabelData {
  /** The whole name, size and all: the office label's, which has no Size line. */
  name: string;
  /** The item label's name — without the size when the size has a line of its own. */
  itemName: string;
  /** The size as the name would show it — `176cm`, `M` — or null. */
  size: string | null;
  /** Null for a ticket not yet priced: printed as a blank to write the price in. */
  priceCents: number | null;
  sellerName: string;
}

/**
 * The helper stickers are a line-for-line port of the iPad's
 * `HelperLabelTemplate`, so the two printers' stickers match. The numbers below
 * are the iPad's; change them there and here together.
 *
 * The stock is 25 mm across the head and 67 along the feed, but a sticker lies
 * across the ticket, so its text runs along the 67 mm: each is laid out in a
 * landscape frame and turned a quarter into the strip the printer burns.
 */
/** Which way the frame turns. The iPad's was set from a test print; copied, not re-derived. */
const HELPER_ROTATION = Math.PI / 2;
/** The smallest a line shrinks to before it is cut, on both stickers: 28 dots, 3.5 mm. */
const HELPER_MIN_SIZE = 28;
/** The item sticker's price, at the size it has always had. */
const HELPER_PRICE_SIZE = 67;
/** Between the size line's row and the top of the price's ink. */
const HELPER_PRICE_GAP = 4;
/** The Size line with no size, so the row is not mistaken for one the printer skipped. */
const HELPER_NO_SIZE = '---';

/**
 * `$45`, or `$19.99` for a price that still has cents. A ticket not yet priced
 * gets `$____`, a blank for staff to write the price in (Plan 32).
 */
export function helperPrice(cents: number | null): string {
  if (cents === null) return '$____';
  return cents % 100 === 0
    ? `$${cents / 100}`
    : `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** How far a string's ink reaches above and below its baseline, rounded up — CoreText's glyph-path bounds, on the iPad. */
function inkExtent(ctx: SKRSContext2D, text: string): { above: number; below: number } {
  if (!text) return { above: 0, below: 0 };
  const m = ctx.measureText(text);
  return { above: Math.ceil(m.actualBoundingBoxAscent), below: Math.ceil(Math.max(0, m.actualBoundingBoxDescent)) };
}

/**
 * Shrinks `text` to the floor, then cuts it and marks the cut, and leaves the
 * font set to the size it is to be drawn at. Never wider than `maxWidth`: the
 * cut is made until the text *and its ellipsis* fit.
 */
function helperLine(ctx: SKRSContext2D, text: string, preferred: number, maxWidth: number): string {
  const size = fitSize(ctx, text, preferred, Math.min(preferred, HELPER_MIN_SIZE), maxWidth);
  ctx.font = labelFont(size, 'bold');
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 0 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trim()}…`;
}

/**
 * The item sticker: name, size and price, for the ticket's Item, Size and Price
 * lines. The price keeps its size and sits on the foot, placed by its ink; the
 * two lines above share what is left.
 *
 * The station's letter sits at the right-hand end of the price row, which is
 * always short, so it never costs the name any room.
 */
export function drawHelperItem(
  ctx: SKRSContext2D, W: number, H: number, data: HelperLabelData, stationCode: string | null,
): void {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';

  // Turned, the strip's length is the line length and its width the label's height.
  const lineLength = H;
  const height = W;

  const price = helperPrice(data.priceCents);
  ctx.font = labelFont(HELPER_PRICE_SIZE, 'bold');
  const ink = inkExtent(ctx, price);
  const rowPitch = (height - ink.above - ink.below - HELPER_PRICE_GAP) / 2;
  const preferred = Math.floor(rowPitch / 1.2);

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(HELPER_ROTATION);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  [data.itemName, data.size ?? HELPER_NO_SIZE].forEach((text, i) => {
    const shown = helperLine(ctx, text, preferred, lineLength);
    ctx.fillText(shown, -lineLength / 2, -height / 2 + rowPitch * (i + 0.5));
  });

  ctx.font = labelFont(HELPER_PRICE_SIZE, 'bold');
  ctx.textBaseline = 'alphabetic';
  const baseline = height / 2 - ink.below;
  ctx.fillText(price, -lineLength / 2, baseline);

  if (stationCode) {
    const size = ink.above + ink.below;
    drawStationBadge(ctx, lineLength / 2 - size, baseline - ink.above, size, stationCode);
  }
  ctx.restore();
}

/**
 * The office sticker: name, price and seller, one to a row, for the office
 * stub. The station's letter sits at the right-hand end of the price row.
 */
export function drawHelperOffice(
  ctx: SKRSContext2D, W: number, H: number, data: HelperLabelData, stationCode: string | null,
): void {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';

  const lines = [data.name, helperPrice(data.priceCents), data.sellerName];
  // Turned, the strip's length is the line length and its width is shared by the rows.
  const lineLength = H;
  const rowPitch = W / lines.length;
  const preferred = Math.floor(rowPitch / 1.25);

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(HELPER_ROTATION);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  lines.forEach((text, i) => {
    const shown = helperLine(ctx, text, preferred, lineLength);
    ctx.fillText(shown, -lineLength / 2, -W / 2 + rowPitch * (i + 0.5));
  });

  if (stationCode) {
    const size = Math.round(rowPitch * 0.8);
    const rowCentre = -W / 2 + rowPitch * 1.5;
    drawStationBadge(ctx, lineLength / 2 - size, rowCentre - size / 2, size, stationCode);
  }
  ctx.restore();
}
