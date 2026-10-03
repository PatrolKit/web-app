import { BadRequestException, Injectable } from '@nestjs/common';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { ensureLabelFonts } from './fonts';
import { buildPrintJob } from './escpos.util';
import {
  BRANDING_STRIP_W,
  CONTENT_BRANDING_GAP,
  DEFAULT_TARGET,
  geometryOf,
  type PrintTarget,
} from './geometry';
import {
  type ItemLabelData,
  type ReceiptHeaderData,
  type ReceiptItemLine,
  calibrationPattern,
  type HelperLabelData,
  drawHelperItem,
  drawHelperOffice,
  drawItemTag,
  drawLargeItemTag,
  drawPrinterLabel,
  drawQrLabel,
  drawReceiptHeader,
  drawReceiptItems,
  drawRotatedBranding,
  drawTallReceipt,
} from './label-templates';

type DrawFn = (ctx: SKRSContext2D, w: number, h: number) => void | Promise<void>;

/**
 * Renders labels to the 1-bit rasters the printer consumes.
 *
 * This is the only implementation. The browser fetches rasters from here rather
 * than drawing its own, and the ESP-32 bridge forwards the bytes untouched — so
 * a margin change ships as a server deploy instead of a firmware rollout, and
 * there is no second renderer to drift out of agreement with this one.
 */
/** What prints on 25 × 67, and all that does (Plan 28). */
export const STRIP_STOCK_MESSAGE =
  'This printer is loaded with 25 × 67 helper labels, and prints nothing else.';

/**
 * Refuses a job its stock cannot take. 25 × 67 — the `strip` tier — holds the
 * helper labels that fill in a legacy ticket and nothing else, and a helper
 * label fits no other stock. A 400 from a web request; from a bridge claim,
 * the job fails with this message rather than printing a layout meant for
 * something else.
 */
function assertStockTakes(target: PrintTarget, helper: boolean): void {
  const strip = target.size.tier === 'strip';
  if (strip && !helper) throw new BadRequestException(STRIP_STOCK_MESSAGE);
  if (!strip && helper) {
    throw new BadRequestException(`Helper labels print on 25 × 67 stock, and this printer holds ${target.size.label}.`);
  }
}

@Injectable()
export class LabelRendererService {
  constructor() {
    ensureLabelFonts();
  }

  // ─── Public templates ───────────────────────────────────────────────────────

  /**
   * Picks the composition by tier rather than by size, so a third stock in an
   * existing tier needs a row in the size table and nothing here.
   */
  itemTag(item: ItemLabelData, target: PrintTarget = DEFAULT_TARGET): Promise<boolean[][]> {
    return this.compose(
      target.size.tier === 'tall'
        ? (ctx, w, h) => drawLargeItemTag(ctx, w, h, item)
        : (ctx, w, h) => drawItemTag(ctx, w, h, item),
      target,
    );
  }

  /**
   * A legacy ticket's two helper stickers, item then office (Plan 28). 25 × 67
   * only. `stationCode` is the letter of the station that asked for them: a
   * ticket number carries none of its own.
   */
  async helperLabels(data: HelperLabelData, stationCode: string | null, target: PrintTarget): Promise<boolean[][][]> {
    return [
      await this.compose((ctx, w, h) => drawHelperItem(ctx, w, h, data, stationCode), target, true),
      await this.compose((ctx, w, h) => drawHelperOffice(ctx, w, h, data, stationCode), target, true),
    ];
  }

  printerLabel(
    printerName: string,
    orgName: string,
    target: PrintTarget = DEFAULT_TARGET,
  ): Promise<boolean[][]> {
    return this.compose((ctx, w, h) => drawPrinterLabel(ctx, w, h, printerName, orgName), target);
  }

  qrLabel(sellerName: string, url: string, target: PrintTarget = DEFAULT_TARGET): Promise<boolean[][]> {
    return this.compose((ctx, w, h) => drawQrLabel(ctx, w, h, sellerName, url), target);
  }

  /**
   * A whole receipt for the tall tier: masthead, code, items and total on one
   * page, spilling onto more only when the list does.
   *
   * Separate from `receiptHeader` + `receiptItems` rather than a variant of
   * them, because it is not the same composition scaled — those two are a
   * header label and a strip of item labels, which is what a 50 × 30 receipt
   * has to be. See `drawTallReceipt`.
   */
  async tallReceipt(
    data: ReceiptHeaderData,
    items: ReceiptItemLine[],
    target: PrintTarget = DEFAULT_TARGET,
  ): Promise<boolean[][][]> {
    const totalCents = items.reduce((sum, i) => sum + (i.priceCents ?? 0), 0);
    const unpricedCount = items.filter((i) => i.priceCents === null).length;
    const pages: boolean[][][] = [];
    let offset = 0;

    // Runs once even with nothing to list: a seller who reaches the end of
    // check-in gets a receipt, and an empty one still carries their QR.
    do {
      let drawnThisPage = 0;
      const index = pages.length;
      pages.push(
        await this.compose(async (ctx, w, h) => {
          ({ rowsDrawn: drawnThisPage } = await drawTallReceipt(
            ctx, w, h, data, items.slice(offset),
            { index, itemCount: items.length, totalCents, unpricedCount },
          ));
        }, target),
      );
      // A single item too tall to fit would otherwise loop forever.
      if (drawnThisPage === 0) break;
      offset += drawnThisPage;
    } while (offset < items.length);

    return pages;
  }

  receiptHeader(data: ReceiptHeaderData, target: PrintTarget = DEFAULT_TARGET): Promise<boolean[][]> {
    return this.compose((ctx, w, h) => drawReceiptHeader(ctx, w, h, data), target);
  }

  /**
   * Paginates an item list across as many labels as it needs. Returns one raster
   * per label, in order — the caller enqueues them with ascending `seq`.
   */
  async receiptItems(
    items: ReceiptItemLine[],
    target: PrintTarget = DEFAULT_TARGET,
  ): Promise<boolean[][][]> {
    // Here as well as in `compose`: an empty list never reaches it, and would
    // otherwise answer "no pages" for stock that cannot take any.
    assertStockTakes(target, false);
    const pages: boolean[][][] = [];
    let offset = 0;
    let isFirst = true;
    while (offset < items.length) {
      let drawnThisPage = 0;
      pages.push(
        await this.compose((ctx, w, h) => {
          drawnThisPage = drawReceiptItems(ctx, w, h, items.slice(offset), isFirst).rowsDrawn;
        }, target),
      );
      // A single item too tall to fit would otherwise loop forever.
      if (drawnThisPage === 0) break;
      offset += drawnThisPage;
      isFirst = false;
    }
    return pages;
  }

  calibration(target: PrintTarget = DEFAULT_TARGET): boolean[][] {
    assertStockTakes(target, false);
    return calibrationPattern(target);
  }

  /**
   * Wraps a raster in the ESC/POS preamble the printer expects.
   *
   * For the browser, which writes these bytes straight to a Phomemo over Web
   * Bluetooth. The ESP-32 bridge takes `toRaster` instead — it builds the
   * ESC/POS itself, and would double-wrap this.
   */
  toPrintJob(rows: boolean[][]): Uint8Array {
    return buildPrintJob(rows);
  }

  /**
   * The bare 1-bit bitmap, packed for the wire.
   *
   * What the bridge receives. Print energy, speed and the blank feed rows are
   * per-printer hardware tuning that the firmware owns, and its ESC/POS builder
   * is byte-verified against ours by its own host suite — so sending a finished
   * job would throw that away and risk a double wrap.
   */
  toRaster(rows: boolean[][]): Buffer {
    return packRaster(rows);
  }

  /**
   * The same raster as a PNG, for on-screen preview.
   *
   * Encoded from the thresholded rows rather than from the source canvas, so
   * what the preview shows is exactly what the head will burn — antialiasing
   * included, or rather excluded.
   */
  toPng(rows: boolean[][]): Buffer {
    const h = rows.length;
    const w = h ? rows[0].length : 0;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = rows[y][x] ? 0 : 255;
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toBuffer('image/png');
  }

  // ─── Compositor ─────────────────────────────────────────────────────────────

  /**
   * Draws the template into the printable area, then places it on a full-head
   * canvas alongside the rotated branding and reduces the result to 1-bit.
   *
   * Templates receive only the content box, so none of them has to know about
   * margins or the branding strip.
   */
  /**
   * Draws a template into three nested boxes and returns the head-width raster.
   *
   *   the head          — what the printer burns, `headWidthDots` across
   *     the media       — the label itself, at `mediaOffsetDots` under the head
   *       the content   — the media inset by the safety margins
   *
   * The middle box is the one that used to be missing. Without it, stock
   * narrower than the head could only be kept on the label by someone typing
   * margins until it looked right, which is why `40x30` was a size in name only.
   */
  private async compose(draw: DrawFn, target: PrintTarget, helper = false): Promise<boolean[][]> {
    assertStockTakes(target, helper);
    const { margins } = target;
    const { headWidthDots, mediaWidthDots, mediaOffsetDots, canvasHeightDots, tier } =
      geometryOf(target);

    const innerH = canvasHeightDots - margins.marginTop - margins.marginBottom;

    // The compact tier parks a rotated branding strip against the right inset
    // and hands the template what is left. The tall tier places its own, so it
    // gets the whole content box.
    const contentW =
      tier === 'compact'
        ? mediaWidthDots - margins.marginRight - BRANDING_STRIP_W - CONTENT_BRANDING_GAP - margins.marginLeft
        : mediaWidthDots - margins.marginLeft - margins.marginRight;

    const inner = createCanvas(contentW, innerH);
    await draw(inner.getContext('2d'), contentW, innerH);

    const full = createCanvas(headWidthDots, canvasHeightDots);
    const ctx = full.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, headWidthDots, canvasHeightDots);
    ctx.drawImage(inner, mediaOffsetDots + margins.marginLeft, margins.marginTop);

    if (tier === 'compact') {
      await drawRotatedBranding(
        ctx, mediaOffsetDots + mediaWidthDots, canvasHeightDots, margins,
      );
    }

    return rasterise(ctx, headWidthDots, canvasHeightDots);
  }
}

/**
 * Row-major, one bit per dot, MSB is the leftmost dot, 1 = burn.
 *
 * The printer's wire format, and the format the golden fixtures are stored in —
 * so a fixture is literally the bytes the bridge is handed.
 */
export function packRaster(rows: boolean[][]): Buffer {
  const width = rows[0]?.length ?? 0;
  const bytesPerRow = Math.ceil(width / 8);
  const out = Buffer.alloc(rows.length * bytesPerRow);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      if (row[x]) out[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x % 8);
    }
  });
  return out;
}

/** Luminance threshold to 1-bit. A thermal head has no greys. */
export function rasterise(ctx: SKRSContext2D, W: number, H: number): boolean[][] {
  const imgData = ctx.getImageData(0, 0, W, H);
  const rows: boolean[][] = [];
  for (let row = 0; row < H; row++) {
    const rowData: boolean[] = new Array<boolean>(W);
    for (let c = 0; c < W; c++) {
      const i = (row * W + c) * 4;
      const lum =
        0.299 * imgData.data[i] + 0.587 * imgData.data[i + 1] + 0.114 * imgData.data[i + 2];
      rowData[c] = lum < 128;
    }
    rows.push(rowData);
  }
  return rows;
}
