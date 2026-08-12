// WebBluetooth driver and label renderer for the Phomemo M110.
// Port of printer_prototype/Sources/PhomemoPrinter/.

// ─── BLE constants ────────────────────────────────────────────────────────────

const PHOMEMO_SERVICE = '0000ff00-0000-1000-8000-00805f9b34fb';
const WRITE_CHAR      = '0000ff02-0000-1000-8000-00805f9b34fb';
const ACK_CHAR        = '0000ff03-0000-1000-8000-00805f9b34fb'; // per-chunk ACK notifications

// ─── Print geometry ───────────────────────────────────────────────────────────

const HEAD_WIDTH_DOTS  = 320; // full print head width — canvas is always this wide
const HEAD_WIDTH_BYTES = 40;
const RASTER_FEED_TOP    = 8; // blank rows prepended to every raster block
const RASTER_FEED_BOTTOM = 8; // blank rows appended  (matches original Swift prototype)
const CHUNK_SIZE       = 182;

// ─── Default margins (dots) — adjust in DevicesPage for each physical printer ─

export const DEFAULT_PRINTER_MARGINS: PrinterMargins = {
  marginTop:    4,
  marginBottom: 4,
  marginLeft:   0,
  marginRight:  28,
};

export interface PrinterMargins {
  marginTop:    number;
  marginBottom: number;
  marginLeft:   number;
  marginRight:  number;
}

// ─── Paper sizes ──────────────────────────────────────────────────────────────

export const PAPER_SIZES = ['40x30', '50x30'] as const;
export type PaperSize = typeof PAPER_SIZES[number];

export const PAPER_SIZE_LABELS: Record<PaperSize, string> = {
  '40x30': '40 × 30 mm',
  '50x30': '50 × 30 mm',
};

// Canvas height in dots at 8 dots/mm (feed rows NOT included — added by printRasterImage)
const PAPER_SIZE_HEIGHT_DOTS: Record<PaperSize, number> = {
  '40x30': 224, // 30mm×8 − 16 feed rows
  '50x30': 384, // 50mm×8 − 16 feed rows
};

const PREVIEW_SCALE = 3;

// ─── Browser support guard ────────────────────────────────────────────────────

export function isWebBluetoothSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

// ─── Connected printer handle ─────────────────────────────────────────────────

export interface ConnectedM110 {
  device: BluetoothDevice;
  bluetoothName: string;
  print(rows: boolean[][]): Promise<void>;
  disconnect(): void;
}

// ─── Code 128 Set B encoder (port of code128BModules in main.swift) ───────────

// ISO/IEC 15417 bar/space width patterns for values 0–102.
const CODE128_PATTERNS: string[] = [
  '212222','222122','222221','121223','121322','131222','122213','122312',
  '132212','221213','221312','231212','112232','122132','122231','113222',
  '123122','123221','223211','221132','221231','213212','223112','312131',
  '311222','321122','321221','312212','322112','322211','212123','212321',
  '232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121',
  '313121','211331','231131','213113','213311','213131','311123','311321',
  '331121','312113','312311','332111','314111','221411','431111','111224',
  '111422','121124','121421','141122','141221','112214','112412','122114',
  '122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112',
  '421211','212141','214121','412121','111143','111341','131141','114113',
  '114311','411113','411311','113141','114131','311141','411131',
];

function expandPattern(pattern: string): boolean[] {
  const mods: boolean[] = [];
  let bar = true;
  for (const ch of pattern) {
    const count = parseInt(ch, 10);
    for (let i = 0; i < count; i++) mods.push(bar);
    bar = !bar;
  }
  return mods;
}

export function code128BModules(text: string): boolean[] {
  let result = expandPattern('211214'); // Start B
  let checksum = 104;
  let idx = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 127) continue;
    const value = code - 32;
    idx++;
    checksum += idx * value;
    result = result.concat(expandPattern(CODE128_PATTERNS[value]));
  }
  result = result.concat(expandPattern(CODE128_PATTERNS[checksum % 103]));
  result = result.concat(expandPattern('2331112')); // Stop
  return result;
}

// ─── Label renderers ──────────────────────────────────────────────────────────

export function generateLabel(
  item: { name: string; priceCents: number; sku: string },
  paperSize: PaperSize = '40x30',
  margins: PrinterMargins = DEFAULT_PRINTER_MARGINS,
): boolean[][] {
  const W = HEAD_WIDTH_DOTS;
  const H = PAPER_SIZE_HEIGHT_DOTS[paperSize];
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  _drawPriceTagToCanvas(ctx, W, H, margins, item);
  return rasterise(ctx, W, H);
}

export function generatePrinterLabel(
  printerName: string,
  orgName: string,
  paperSize: PaperSize = '40x30',
  margins: PrinterMargins = DEFAULT_PRINTER_MARGINS,
): boolean[][] {
  const W = HEAD_WIDTH_DOTS;
  const H = PAPER_SIZE_HEIGHT_DOTS[paperSize];
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  _drawPrinterLabelToCanvas(ctx, W, H, margins, printerName, orgName);
  return rasterise(ctx, W, H);
}

/** Calibration pattern:
 *  – full-canvas X diagonals showing absolute printable extents
 *  – rectangle outline at the configured margin boundaries
 *  – crosshair at the centre of the margin box */
export function generateCalibrationPattern(paperSize: PaperSize = '40x30', margins: PrinterMargins = DEFAULT_PRINTER_MARGINS): boolean[][] {
  const W = HEAD_WIDTH_DOTS;
  const H = PAPER_SIZE_HEIGHT_DOTS[paperSize];
  const rows: boolean[][] = Array.from({ length: H }, () => new Array(W).fill(false));
  const D = 2; // line thickness in dots

  const L  = margins.marginLeft;
  const R  = W - margins.marginRight;       // exclusive
  const T  = margins.marginTop;
  const B  = H - margins.marginBottom;      // exclusive
  const CX = Math.round((L + R - D) / 2);
  const CY = Math.round((T + B - D) / 2);

  function hline(y: number, x0: number, x1: number) {
    for (let d = 0; d < D; d++) if (y + d < H) for (let x = x0; x < x1; x++) rows[y + d][x] = true;
  }
  function vline(x: number, y0: number, y1: number) {
    for (let d = 0; d < D; d++) if (x + d < W) for (let y = y0; y < y1; y++) rows[y][x + d] = true;
  }

  // Full-canvas diagonals
  for (let y = 0; y < H; y++) {
    const x1 = Math.round(y * (W - 1) / (H - 1));
    const x2 = (W - 1) - x1;
    if (x1 < W)     rows[y][x1]     = true;
    if (x1 + 1 < W) rows[y][x1 + 1] = true;
    if (x2 >= 0)    rows[y][x2]     = true;
    if (x2 - 1 >= 0) rows[y][x2 - 1] = true;
  }

  // Margin box outline
  hline(T,     L, R); // top
  hline(B - D, L, R); // bottom
  vline(L,     T, B); // left
  vline(R - D, T, B); // right

  // Crosshair at centre of box
  hline(CY, L, R); // horizontal arm
  vline(CX, T, B); // vertical arm

  return rows;
}

function _drawPriceTagToCanvas(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  m: PrinterMargins, item: { name: string; priceCents: number; sku: string },
) {
  const CX      = m.marginLeft + (W - m.marginLeft - m.marginRight) / 2;
  const W_INNER = W - m.marginLeft - m.marginRight;
  const H_INNER = H - m.marginTop - m.marginBottom;
  const halfH   = m.marginTop + Math.floor(H_INNER / 2);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';

  const modules = code128BModules(item.sku);
  const moduleW = 2;
  const barcodeW = modules.length * moduleW;
  let col = Math.floor(CX - barcodeW / 2);
  for (const black of modules) {
    if (col >= 0 && col + moduleW <= W) {
      if (black) ctx.fillRect(col, m.marginTop, moduleW, 64);
    }
    col += moduleW;
  }

  ctx.font = '16px "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(item.sku, CX, halfH - 10);

  ctx.fillRect(m.marginLeft, halfH, W_INNER, 1);

  const bottomH = H - m.marginBottom - halfH;
  const priceStr = `$${(item.priceCents / 100).toFixed(2)}`;
  ctx.font = 'bold 44px "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.fillText(priceStr, CX, halfH + Math.floor(bottomH * 0.55));

  ctx.font = '15px "Helvetica Neue", Helvetica, Arial, sans-serif';
  let displayName = item.name;
  while (ctx.measureText(displayName).width > W_INNER && displayName.length > 1) displayName = displayName.slice(0, -1);
  if (displayName !== item.name) displayName = displayName.slice(0, -1) + '\u2026';
  ctx.fillText(displayName, CX, halfH + Math.floor(bottomH * 0.82));
}

function _drawPrinterLabelToCanvas(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  m: PrinterMargins, printerName: string, orgName: string,
) {
  const SANS    = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  const CX      = m.marginLeft + (W - m.marginLeft - m.marginRight) / 2;
  const W_INNER = W - m.marginLeft - m.marginRight;
  const H_INNER = H - m.marginTop - m.marginBottom;
  const y = (frac: number) => m.marginTop + Math.floor(H_INNER * frac);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const yPrinterName  = y(0.16);
  const yHiLabel      = yPrinterName - 20;
  const yOrgName      = y(0.60);
  const yBelongsLabel = yOrgName - 20;
  const yLogoBlock    = y(0.85);
  const yPoweredBy    = yLogoBlock - 12;

  ctx.font = `20px ${SANS}`;
  ctx.fillText('Hi! My name is:', CX, yHiLabel);

  ctx.font = `bold 38px ${SANS}`;
  let pName = printerName;
  while (ctx.measureText(pName).width > W_INNER && pName.length > 1) pName = pName.slice(0, -1);
  if (pName !== printerName) pName = pName.slice(0, -1) + '\u2026';
  ctx.fillText(pName, CX, yPrinterName);

  ctx.font = `20px ${SANS}`;
  ctx.fillText('I belong to:', CX, yBelongsLabel);

  ctx.font = `bold 28px ${SANS}`;
  let oName = orgName;
  while (ctx.measureText(oName).width > W_INNER && oName.length > 1) oName = oName.slice(0, -1);
  if (oName !== orgName) oName = oName.slice(0, -1) + '\u2026';
  ctx.fillText(oName, CX, yOrgName);

  ctx.font = `12px ${SANS}`;
  ctx.fillStyle = '#555';
  ctx.fillText('Powered by', CX, yPoweredBy);

  const LOGO_SIZE = 20;
  const LOGO_TEXT_SIZE = 14;
  ctx.font = `bold ${LOGO_TEXT_SIZE}px ${SANS}`;
  ctx.fillStyle = '#000';
  const textW = ctx.measureText('PatrolKit').width;
  const GAP = 5;
  const blockW = LOGO_SIZE + GAP + textW;
  const logoX = Math.floor(CX - blockW / 2);

  const scale = LOGO_SIZE / 32;
  ctx.save();
  ctx.translate(logoX, yLogoBlock);
  ctx.scale(scale, scale);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2 / scale;
  ctx.stroke(new Path2D('M16 2L4 7V16C4 22.627 9.373 29 16 30C22.627 29 28 22.627 28 16V7L16 2Z'));
  ctx.fillStyle = '#000';
  ctx.fillRect(14, 10, 4, 12);
  ctx.fillRect(10, 14, 12, 4);
  ctx.restore();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `bold ${LOGO_TEXT_SIZE}px ${SANS}`;
  ctx.fillStyle = '#000';
  ctx.fillText('PatrolKit', logoX + LOGO_SIZE + GAP, yLogoBlock + (LOGO_SIZE - LOGO_TEXT_SIZE) / 2);
}

function rasterise(ctx: CanvasRenderingContext2D, W: number, H: number): boolean[][] {
  const imgData = ctx.getImageData(0, 0, W, H);
  const rows: boolean[][] = [];
  for (let row = 0; row < H; row++) {
    const rowData: boolean[] = [];
    for (let c = 0; c < W; c++) {
      const i = (row * W + c) * 4;
      const lum = 0.299 * imgData.data[i] + 0.587 * imgData.data[i + 1] + 0.114 * imgData.data[i + 2];
      rowData.push(lum < 128);
    }
    rows.push(rowData);
  }
  return rows;
}

function canvasToPreviewDataUrl(src: HTMLCanvasElement): string {
  const preview = document.createElement('canvas');
  preview.width  = src.width  * PREVIEW_SCALE;
  preview.height = src.height * PREVIEW_SCALE;
  const ctx = preview.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, preview.width, preview.height);
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, preview.width - 1, preview.height - 1);
  return preview.toDataURL('image/png');
}

export function previewLabel(
  item: { name: string; priceCents: number; sku: string },
  paperSize: PaperSize = '40x30',
  margins: PrinterMargins = DEFAULT_PRINTER_MARGINS,
): string {
  const W = HEAD_WIDTH_DOTS;
  const H = PAPER_SIZE_HEIGHT_DOTS[paperSize];
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  _drawPriceTagToCanvas(canvas.getContext('2d')!, W, H, margins, item);
  return canvasToPreviewDataUrl(canvas);
}

export function previewPrinterLabel(
  printerName: string, orgName: string,
  paperSize: PaperSize = '40x30',
  margins: PrinterMargins = DEFAULT_PRINTER_MARGINS,
): string {
  const W = HEAD_WIDTH_DOTS;
  const H = PAPER_SIZE_HEIGHT_DOTS[paperSize];
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  _drawPrinterLabelToCanvas(canvas.getContext('2d')!, W, H, margins, printerName, orgName);
  return canvasToPreviewDataUrl(canvas);
}

export function previewCalibrationPattern(paperSize: PaperSize = '40x30', margins: PrinterMargins = DEFAULT_PRINTER_MARGINS): string {
  const rows = generateCalibrationPattern(paperSize, margins);
  const W = HEAD_WIDTH_DOTS;
  const H = rows.length;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++)
      if (rows[r][c]) ctx.fillRect(c, r, 1, 1);
  return canvasToPreviewDataUrl(canvas);
}

// ─── ESC/POS command builders ─────────────────────────────────────────────────

function initialize(): Uint8Array { return new Uint8Array([0x1b, 0x40]); }
function setPrintEnergy(level = 2): Uint8Array { return new Uint8Array([0x1f, 0x11, 0x08, Math.min(level, 2)]); }
function setPrintSpeed(level = 3): Uint8Array { return new Uint8Array([0x1f, 0x11, 0x07, level]); }
function feed(dots = 30): Uint8Array { return new Uint8Array([0x1b, 0x4a, dots]); }

function printRasterImage(rows: boolean[][]): Uint8Array {
  const H      = rows.length;
  const totalH = H + RASTER_FEED_TOP + RASTER_FEED_BOTTOM;
  const blank  = new Uint8Array(HEAD_WIDTH_BYTES);
  const buf: number[] = [
    0x1d, 0x76, 0x30, 0x00,
    HEAD_WIDTH_BYTES & 0xff, HEAD_WIDTH_BYTES >> 8,
    totalH & 0xff, totalH >> 8,
  ];
  for (let i = 0; i < RASTER_FEED_TOP; i++) buf.push(...blank);
  for (let r = 0; r < H; r++) {
    const headRow = new Uint8Array(HEAD_WIDTH_BYTES);
    for (let c = 0; c < HEAD_WIDTH_DOTS; c++) {
      if (rows[r][c]) headRow[Math.floor(c / 8)] |= 0x80 >> (c % 8);
    }
    buf.push(...headRow);
  }
  for (let i = 0; i < RASTER_FEED_BOTTOM; i++) buf.push(...blank);
  return new Uint8Array(buf);
}

function buildPrintJob(rows: boolean[][]): Uint8Array {
  const parts = [initialize(), setPrintEnergy(2), setPrintSpeed(3), printRasterImage(rows), feed(30)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

// ─── BLE write with sliding-window ACK ───────────────────────────────────────
// Send up to WINDOW chunks ahead of acknowledgements so the printer buffer stays
// full and the paper motor never stalls waiting for data.

const WINDOW = 3; // chunks in-flight before pausing for ACKs

async function sendJob(
  writeChar: BluetoothRemoteGATTCharacteristic,
  ackChar: BluetoothRemoteGATTCharacteristic,
  job: Uint8Array,
): Promise<void> {
  let ackCount  = 0;
  let sentCount = 0;
  let offset    = 0;

  function onAck(event: Event) {
    const v = (event.target as BluetoothRemoteGATTCharacteristic).value!;
    if (v && v.byteLength === 2 && v.getUint8(0) === 0x01 && v.getUint8(1) === 0x01) ackCount++;
  }
  ackChar.addEventListener('characteristicvaluechanged', onAck);

  try {
    while (offset < job.length) {
      // Pause if we are WINDOW chunks ahead of acknowledged chunks
      if (sentCount - ackCount >= WINDOW) {
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 5000;
          function poll() {
            if (ackCount >= sentCount - WINDOW + 1) { resolve(); return; }
            if (Date.now() > deadline) { reject(new Error('Printer ACK timeout')); return; }
            setTimeout(poll, 1);
          }
          poll();
        });
      }

      const chunk = job.slice(offset, Math.min(offset + CHUNK_SIZE, job.length));
      offset += CHUNK_SIZE;
      await writeChar.writeValueWithoutResponse(chunk);
      sentCount++;
    }

    // Drain remaining ACKs
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      function drain() {
        if (ackCount >= sentCount) { resolve(); return; }
        if (Date.now() > deadline) { reject(new Error('Printer ACK timeout')); return; }
        setTimeout(drain, 1);
      }
      drain();
    });
  } finally {
    ackChar.removeEventListener('characteristicvaluechanged', onAck);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Connect to a BluetoothDevice that has already been granted permission. No picker shown. */
async function connectDevice(device: BluetoothDevice): Promise<ConnectedM110> {
  const server = await device.gatt!.connect();
  const service = await server.getPrimaryService(PHOMEMO_SERVICE);
  const writeChar = await service.getCharacteristic(WRITE_CHAR);
  const ackChar   = await service.getCharacteristic(ACK_CHAR);
  await ackChar.startNotifications();

  return {
    device,
    bluetoothName: device.name ?? '',
    async print(rows: boolean[][]): Promise<void> {
      const job = buildPrintJob(rows);
      await sendJob(writeChar, ackChar, job);
    },
    disconnect(): void {
      device.gatt?.disconnect();
    },
  };
}

/** Connect using a device reference already held by the caller — no picker, no getDevices(). */
export async function connectFromDevice(device: BluetoothDevice): Promise<ConnectedM110> {
  return connectDevice(device);
}

/** Show BLE picker filtered to specific printer BT names; falls back to service UUID if list is empty. */
export async function connectFromPool(allowedBtNames: string[]): Promise<ConnectedM110> {
  const filters = allowedBtNames.length > 0
    ? allowedBtNames.map((name) => ({ name }))
    : [{ services: [PHOMEMO_SERVICE] as BluetoothServiceUUID[] }];

  const device = await navigator.bluetooth.requestDevice({
    filters,
    optionalServices: [PHOMEMO_SERVICE],
  });
  return connectDevice(device);
}

/** Show the native BLE picker and connect. Requires a user gesture. */
export async function connectPrinter(bluetoothName: string): Promise<ConnectedM110> {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ name: bluetoothName }],
    optionalServices: [PHOMEMO_SERVICE],
  });
  return connectDevice(device);
}

/** Attempt silent reconnect to a previously-permitted device (no user gesture required). */
export async function reconnectPrinter(bluetoothName: string): Promise<ConnectedM110 | null> {
  if (!('getDevices' in navigator.bluetooth)) return null;
  try {
    const devices = await (navigator.bluetooth as any).getDevices() as BluetoothDevice[];
    const device = devices.find((d) => d.name === bluetoothName);
    if (!device) return null;
    return await connectDevice(device);
  } catch {
    return null;
  }
}
