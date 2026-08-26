/**
 * Print geometry for the Phomemo M110.
 *
 * The head is 400 dots wide — 50 mm at 8 dots/mm — and prints the full width of
 * 50 mm media. Paper size describes the *media*, not the head: `40x30` is
 * narrower stock under the same head, kept on the label by margins.
 */

export const HEAD_WIDTH_DOTS = 400;
export const HEAD_WIDTH_BYTES = HEAD_WIDTH_DOTS / 8; // 50

/** Blank rows the printer feeds before and after every raster block. */
export const RASTER_FEED_TOP = 8;
export const RASTER_FEED_BOTTOM = 8;

/** Rotated branding footprint: PB_SIZE 11 + gap 2 + LOGO_SIZE 16. */
export const BRANDING_STRIP_W = 29;
/** Gap between the content's right edge and the branding strip. */
export const CONTENT_BRANDING_GAP = 4;

export const PAPER_SIZES = ['40x30', '50x30'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

/**
 * Canvas height in dots at 8 dots/mm, feed rows excluded. Both sizes are 30 mm
 * in the feed direction; the first dimension is the label width.
 */
export const PAPER_SIZE_HEIGHT_DOTS: Record<PaperSize, number> = {
  '40x30': 224, // 30mm × 8 − 16 feed rows
  '50x30': 224,
};

export interface PrinterMargins {
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

export const DEFAULT_PRINTER_MARGINS: PrinterMargins = {
  marginTop: 4,
  marginBottom: 4,
  marginLeft: 0,
  marginRight: 28,
};

/** Everything a render needs to know about the physical target. */
export interface PrintTarget {
  paperSize: PaperSize;
  margins: PrinterMargins;
}

export function isPaperSize(v: string): v is PaperSize {
  return (PAPER_SIZES as readonly string[]).includes(v);
}
