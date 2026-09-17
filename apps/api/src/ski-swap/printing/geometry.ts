/**
 * What the renderer needs to know about the hardware it is drawing for.
 *
 * Two independent facts, kept independent: **which printer** (how wide its head
 * is, and where narrower stock sits under it) and **which stock** (how big the
 * label is). They used to be one string, `paperSize`, with the head as a module
 * constant — which worked only because there was one printer.
 *
 * Margins are neither. They are a safety inset: labels do not always sit square
 * in the printer, and anything drawn to the exact edge is the first thing lost,
 * so the margin pulls all content inward and a crooked label still prints whole.
 * Where the media sits under the head is a hardware fact and is computed here;
 * margins never do that job.
 */

export const DOTS_PER_MM = 8;

/** Blank rows the printer feeds before and after every raster block. */
export const RASTER_FEED_TOP = 8;
export const RASTER_FEED_BOTTOM = 8;

export interface PrinterMargins {
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

// ─── Printers ─────────────────────────────────────────────────────────────────

export const PRINTER_MODELS = ['m110', 'm221'] as const;
export type PrinterModelId = (typeof PRINTER_MODELS)[number];

export interface PrinterModel {
  id: PrinterModelId;
  label: string;
  headWidthDots: number;
  /**
   * Where stock narrower than the head sits. A hardware fact, measured rather
   * than chosen — get it wrong and content prints onto the liner.
   */
  mediaAlignment: 'left' | 'centre' | 'right';
}

export const PRINTER_MODEL: Record<PrinterModelId, PrinterModel> = {
  m110: {
    id: 'm110',
    label: 'Phomemo M110',
    // 50 mm at 8 dots/mm. Not independently verified: the only stock this model
    // takes fills the head, and `marginRight` has always kept content inside dot
    // 372, so a 384-dot head would look identical in everything we have printed.
    headWidthDots: 400,
    // Unobservable while the only stock fills the head. Left is what the code
    // has always done, so it is what is recorded.
    mediaAlignment: 'left',
  },
  m221: {
    id: 'm221',
    label: 'Phomemo M221',
    /*
     * 72 mm. The printer decided this, and it is the only witness that counts.
     *
     * It was set to 600 (75 mm) on the manufacturer's quoted maximum print width
     * plus a reading of a calibration label — where the diagonals appeared to
     * meet the media's edge about 8 mm down, which 600 predicts and 576 does
     * not. That reading was pixels estimated by eye off a photograph, and it was
     * wrong: at 600 the printer prints nothing at all, and at 576 it prints.
     *
     * The failure mode is worth knowing because it makes this number
     * self-verifying. `GS v 0` declares bytes per row in its header, so too
     * large a head is not a shifted label or a clipped one — the printer appears
     * to reject the raster outright and no paper moves. If a label size ever
     * prints blank on new hardware, suspect this before anything else.
     *
     * The quoted "20–75 mm print width" is presumably the media it accepts
     * rather than the dots it has.
     */
    headWidthDots: 576,
    /*
     * There is a physical guide that centres stock, and the calibration
     * diagonals cross on the label's centreline rather than off to one side.
     *
     * Centring means an error in the head width shifts content by half the
     * error rather than pushing it off the label — but only for an error small
     * enough to print at all. See above: too large and nothing comes out.
     */
    mediaAlignment: 'centre',
  },
};

// ─── Stock ────────────────────────────────────────────────────────────────────

export const PAPER_SIZES = ['50x30', '62x100'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

/**
 * Which composition the templates draw.
 *
 * Not every size needs its own layout, but 50 × 30 and 62 × 100 are genuinely
 * different compositions rather than one scaled — so sizes name a tier and
 * templates implement one per tier. A new size in an existing tier is free.
 */
export type LabelTier = 'compact' | 'tall';

export interface LabelSize {
  id: PaperSize;
  label: string;
  widthMm: number;
  heightMm: number;
  tier: LabelTier;
  /** Models this stock runs on. Media wider than the head is unprintable. */
  models: PrinterModelId[];
  /**
   * Starting safety inset, in dots.
   *
   * A property of the stock rather than the printer: 4 dots is half a millimetre,
   * a sensible fraction of a 30 mm label and nearly nothing on a 100 mm one. A
   * printer row overrides these only when somebody has a reason.
   */
  defaultMargins: PrinterMargins;
}

export const LABEL_SIZE: Record<PaperSize, LabelSize> = {
  '50x30': {
    id: '50x30',
    label: '50 × 30 mm',
    widthMm: 50,
    heightMm: 30,
    tier: 'compact',
    models: ['m110'],
    // The right inset is wide because the compact tier parks its branding strip
    // against this boundary. See `compose`.
    defaultMargins: { marginTop: 4, marginBottom: 4, marginLeft: 0, marginRight: 28 },
  },
  '62x100': {
    id: '62x100',
    label: '62 × 100 mm',
    widthMm: 62,
    heightMm: 100,
    tier: 'tall',
    models: ['m221'],
    // 2 mm all round. The tall tier places its own branding, so this is only
    // ever the inset.
    defaultMargins: { marginTop: 16, marginBottom: 16, marginLeft: 16, marginRight: 16 },
  },
};

// ─── The compact tier's branding strip ────────────────────────────────────────

/** Rotated branding footprint: PB_SIZE 11 + gap 2 + LOGO_SIZE 16. */
export const BRANDING_STRIP_W = 29;
/** Gap between the content's right edge and the branding strip. */
export const CONTENT_BRANDING_GAP = 4;

// ─── Targets ──────────────────────────────────────────────────────────────────

/** Everything a render needs to know about the physical target. */
export interface PrintTarget {
  model: PrinterModel;
  size: LabelSize;
  margins: PrinterMargins;
}

/** The dots a target works out to. Derived on demand so it cannot go stale. */
export interface TargetGeometry {
  headWidthDots: number;
  mediaWidthDots: number;
  /** Where the media's left edge sits under the head. */
  mediaOffsetDots: number;
  /** Canvas height, feed rows excluded. */
  canvasHeightDots: number;
  tier: LabelTier;
}

export function geometryOf(target: PrintTarget): TargetGeometry {
  const headWidthDots = target.model.headWidthDots;
  const mediaWidthDots = target.size.widthMm * DOTS_PER_MM;
  const slack = Math.max(0, headWidthDots - mediaWidthDots);

  const mediaOffsetDots =
    target.model.mediaAlignment === 'centre' ? Math.floor(slack / 2)
    : target.model.mediaAlignment === 'right' ? slack
    : 0;

  return {
    headWidthDots,
    mediaWidthDots,
    mediaOffsetDots,
    canvasHeightDots: target.size.heightMm * DOTS_PER_MM - RASTER_FEED_TOP - RASTER_FEED_BOTTOM,
    tier: target.size.tier,
  };
}

/** Builds a target, falling back to each side's default when asked for nonsense. */
export function printTarget(
  modelId: string,
  paperSize: string,
  margins?: Partial<PrinterMargins>,
): PrintTarget {
  const model = PRINTER_MODEL[isPrinterModelId(modelId) ? modelId : 'm110'];
  const size = LABEL_SIZE[isPaperSize(paperSize) ? paperSize : defaultSizeFor(model.id)];
  return {
    model,
    size,
    margins: { ...size.defaultMargins, ...stripUndefined(margins) },
  };
}

/** The stock a model runs on when nothing says otherwise. */
export function defaultSizeFor(modelId: PrinterModelId): PaperSize {
  return sizesFor(modelId)[0] ?? '50x30';
}

/** Sizes this model can print, in declaration order. */
export function sizesFor(modelId: PrinterModelId): PaperSize[] {
  return PAPER_SIZES.filter((s) => LABEL_SIZE[s].models.includes(modelId));
}

export const DEFAULT_TARGET: PrintTarget = printTarget('m110', '50x30');

export function isPaperSize(v: string): v is PaperSize {
  return (PAPER_SIZES as readonly string[]).includes(v);
}

export function isPrinterModelId(v: string): v is PrinterModelId {
  return (PRINTER_MODELS as readonly string[]).includes(v);
}

function stripUndefined(m?: Partial<PrinterMargins>): Partial<PrinterMargins> {
  if (!m) return {};
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined));
}
