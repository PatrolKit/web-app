import { Injectable } from '@nestjs/common';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { ensureLabelFonts } from './fonts';
import { buildPrintJob } from './escpos.util';
import {
  BRANDING_STRIP_W,
  CONTENT_BRANDING_GAP,
  DEFAULT_PRINTER_MARGINS,
  HEAD_WIDTH_DOTS,
  PAPER_SIZE_HEIGHT_DOTS,
  type PrintTarget,
} from './geometry';
import {
  calibrationPattern,
  drawItemTag,
  drawPrinterLabel,
  drawQrLabel,
  drawReceiptHeader,
  drawReceiptItems,
  drawRotatedBranding,
  type ItemLabelData,
  type ReceiptHeaderData,
} from './label-templates';

type DrawFn = (ctx: SKRSContext2D, w: number, h: number) => void | Promise<void>;

const DEFAULT_TARGET: PrintTarget = {
  paperSize: '50x30',
  margins: DEFAULT_PRINTER_MARGINS,
};

/**
 * Renders labels to the 1-bit rasters the printer consumes.
 *
 * This is the only implementation. The browser fetches rasters from here rather
 * than drawing its own, and the ESP-32 bridge forwards the bytes untouched — so
 * a margin change ships as a server deploy instead of a firmware rollout, and
 * there is no second renderer to drift out of agreement with this one.
 */
@Injectable()
export class LabelRendererService {
  constructor() {
    ensureLabelFonts();
  }

  // ─── Public templates ───────────────────────────────────────────────────────

  itemTag(item: ItemLabelData, target: PrintTarget = DEFAULT_TARGET): Promise<boolean[][]> {
    return this.compose((ctx, w, h) => drawItemTag(ctx, w, h, item), target);
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

  receiptHeader(data: ReceiptHeaderData, target: PrintTarget = DEFAULT_TARGET): Promise<boolean[][]> {
    return this.compose((ctx, w, h) => drawReceiptHeader(ctx, w, h, data), target);
  }

  /**
   * Paginates an item list across as many labels as it needs. Returns one raster
   * per label, in order — the caller enqueues them with ascending `seq`.
   */
  async receiptItems(
    items: { name: string; sku: string; priceCents: number }[],
    target: PrintTarget = DEFAULT_TARGET,
  ): Promise<boolean[][][]> {
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
    return calibrationPattern(target.paperSize, target.margins);
  }

  /** Wraps a raster in the ESC/POS preamble the printer expects. */
  toPrintJob(rows: boolean[][]): Uint8Array {
    return buildPrintJob(rows);
  }

  // ─── Compositor ─────────────────────────────────────────────────────────────

  /**
   * Draws the template into the printable area, then places it on a full-head
   * canvas alongside the rotated branding and reduces the result to 1-bit.
   *
   * Templates receive only the content box, so none of them has to know about
   * margins or the branding strip.
   */
  private async compose(draw: DrawFn, target: PrintTarget): Promise<boolean[][]> {
    const { margins, paperSize } = target;
    const fullW = HEAD_WIDTH_DOTS;
    const fullH = PAPER_SIZE_HEIGHT_DOTS[paperSize];
    const innerH = fullH - margins.marginTop - margins.marginBottom;
    const brandingLeft = fullW - margins.marginRight - BRANDING_STRIP_W;
    const contentW = brandingLeft - CONTENT_BRANDING_GAP - margins.marginLeft;

    const inner = createCanvas(contentW, innerH);
    await draw(inner.getContext('2d'), contentW, innerH);

    const full = createCanvas(fullW, fullH);
    const ctx = full.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, fullW, fullH);
    ctx.drawImage(inner, margins.marginLeft, margins.marginTop);
    await drawRotatedBranding(ctx, fullW, fullH, margins);

    return rasterise(ctx, fullW, fullH);
  }
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
