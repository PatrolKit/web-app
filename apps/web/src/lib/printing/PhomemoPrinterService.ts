// WebBluetooth driver and label renderer for the Phomemo M110.
// Port of printer_prototype/Sources/PhomemoPrinter/.

// ─── BLE constants ────────────────────────────────────────────────────────────

const PHOMEMO_SERVICE = '0000ff00-0000-1000-8000-00805f9b34fb';
const WRITE_CHAR      = '0000ff02-0000-1000-8000-00805f9b34fb';
const ACK_CHAR        = '0000ff03-0000-1000-8000-00805f9b34fb'; // per-chunk ACK notifications

// ─── Print geometry (matches PrintCommands.swift) ─────────────────────────────

const HEAD_WIDTH_DOTS     = 320;
const HEAD_WIDTH_BYTES    = 40;
const LEFT_OFFSET_DOTS    = 16;
const CONTENT_WIDTH_DOTS  = 304;
const PRINT_HEIGHT_DOTS   = 240;
const TOP_MARGIN_ROWS     = 8;
const CONTENT_HEIGHT_DOTS = 224; // PRINT_HEIGHT_DOTS - TOP_MARGIN_ROWS - BOTTOM_MARGIN_ROWS
const CHUNK_SIZE          = 182;

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

// ─── Label renderer (port of generateSkiSwapLabel in main.swift) ─────────────

export function generateLabel(item: { name: string; priceCents: number; sku: string }): boolean[][] {
  const W = CONTENT_WIDTH_DOTS;
  const H = CONTENT_HEIGHT_DOTS;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';

  // ── Top half: Code128 barcode ────────────────────────────────────────────
  const modules = code128BModules(item.sku);
  const moduleW = 2;
  const barcodeW = modules.length * moduleW;
  let col = Math.floor((W - barcodeW) / 2);
  for (const black of modules) {
    if (col >= 0 && col + moduleW <= W) {
      if (black) ctx.fillRect(col, 8, moduleW, 64);
    }
    col += moduleW;
  }

  // SKU text — baseline row 87
  ctx.font = '16px "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(item.sku, W / 2, 87);

  // ── Separator ────────────────────────────────────────────────────────────
  ctx.fillRect(16, 112, W - 32, 1);

  // ── Bottom half: price + item name ───────────────────────────────────────
  const priceStr = `$${(item.priceCents / 100).toFixed(2)}`;
  ctx.font = 'bold 44px "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.fillText(priceStr, W / 2, 173);

  ctx.font = '15px "Helvetica Neue", Helvetica, Arial, sans-serif';
  // Truncate item name to fit within label width
  let displayName = item.name;
  while (ctx.measureText(displayName).width > W - 8 && displayName.length > 1) {
    displayName = displayName.slice(0, -1);
  }
  if (displayName !== item.name) displayName = displayName.slice(0, -1) + '…';
  ctx.fillText(displayName, W / 2, 200);

  // ── Rasterise ────────────────────────────────────────────────────────────
  const imageData = ctx.getImageData(0, 0, W, H);
  const rows: boolean[][] = [];
  for (let row = 0; row < H; row++) {
    const rowData: boolean[] = [];
    for (let c = 0; c < W; c++) {
      const i = (row * W + c) * 4;
      // Simple luminance threshold; white = 255 background
      const lum = 0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2];
      rowData.push(lum < 128);
    }
    rows.push(rowData);
  }
  return rows;
}

/** Printer identification label — "Hi! My name is: <name> / I belong to: <org> / PatrolKit logo" */
export function generatePrinterLabel(printerName: string, orgName: string): boolean[][] {
  const W = CONTENT_WIDTH_DOTS;
  const H = CONTENT_HEIGHT_DOTS;
  const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // ── "Hi! My name is:" ─────────────────────────────────────────────────────
  ctx.font = `11px ${SANS}`;
  ctx.fillText('Hi! My name is:', W / 2, 8);

  // ── Printer name ──────────────────────────────────────────────────────────
  ctx.font = `bold 20px ${SANS}`;
  let pName = printerName;
  while (ctx.measureText(pName).width > W - 16 && pName.length > 1) pName = pName.slice(0, -1);
  if (pName !== printerName) pName = pName.slice(0, -1) + '…';
  ctx.fillText(pName, W / 2, 26);

  // ── "I belong to:" ────────────────────────────────────────────────────────
  ctx.font = `11px ${SANS}`;
  ctx.fillText('I belong to:', W / 2, 58);

  // ── Org name ──────────────────────────────────────────────────────────────
  ctx.font = `bold 16px ${SANS}`;
  let oName = orgName;
  while (ctx.measureText(oName).width > W - 16 && oName.length > 1) oName = oName.slice(0, -1);
  if (oName !== orgName) oName = oName.slice(0, -1) + '…';
  ctx.fillText(oName, W / 2, 76);

  // ── Separator ─────────────────────────────────────────────────────────────
  ctx.fillRect(16, 106, W - 32, 1);

  // ── PatrolKit logo block (shield + text), centred in bottom section ───────
  const LOGO_SIZE = 28;
  ctx.font = `bold 18px ${SANS}`;
  const textW = ctx.measureText('PatrolKit').width;
  const GAP = 6;
  const blockW = LOGO_SIZE + GAP + textW;
  const logoX = Math.floor((W - blockW) / 2);
  const logoY = Math.floor(114 + (H - 114 - LOGO_SIZE) / 2);

  // Draw shield using Path2D (SVG path from landing page logo, scaled to LOGO_SIZE)
  const scale = LOGO_SIZE / 32;
  ctx.save();
  ctx.translate(logoX, logoY);
  ctx.scale(scale, scale);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2 / scale;
  ctx.stroke(new Path2D('M16 2L4 7V16C4 22.627 9.373 29 16 30C22.627 29 28 22.627 28 16V7L16 2Z'));
  ctx.fillStyle = '#000';
  ctx.fillRect(14, 10, 4, 12); // vertical bar
  ctx.fillRect(10, 14, 12, 4); // horizontal bar
  ctx.restore();

  // "PatrolKit" vertically centred beside the shield
  ctx.textAlign = 'left';
  ctx.font = `bold 18px ${SANS}`;
  ctx.fillStyle = '#000';
  ctx.fillText('PatrolKit', logoX + LOGO_SIZE + GAP, logoY + (LOGO_SIZE - 18) / 2);

  // ── Rasterise ─────────────────────────────────────────────────────────────
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

// ─── ESC/POS command builders (port of PrintCommands.swift) ──────────────────

function initialize(): Uint8Array { return new Uint8Array([0x1b, 0x40]); }
function setPrintEnergy(level = 2): Uint8Array { return new Uint8Array([0x1f, 0x11, 0x08, Math.min(level, 2)]); }
function setPrintSpeed(level = 3): Uint8Array { return new Uint8Array([0x1f, 0x11, 0x07, level]); }
function feed(dots = 30): Uint8Array { return new Uint8Array([0x1b, 0x4a, dots]); }

function printRasterImage(rows: boolean[][]): Uint8Array {
  const totalH = PRINT_HEIGHT_DOTS;
  const blankRow = new Uint8Array(HEAD_WIDTH_BYTES);
  const buf: number[] = [
    0x1d, 0x76, 0x30, 0x00,
    HEAD_WIDTH_BYTES & 0xff, HEAD_WIDTH_BYTES >> 8,
    totalH & 0xff, totalH >> 8,
  ];

  for (let i = 0; i < TOP_MARGIN_ROWS; i++) buf.push(...blankRow);

  const contentRows = Math.min(rows.length, CONTENT_HEIGHT_DOTS);
  for (let r = 0; r < contentRows; r++) {
    const headRow = new Uint8Array(HEAD_WIDTH_BYTES);
    for (let c = 0; c < CONTENT_WIDTH_DOTS; c++) {
      const headCol = c + LEFT_OFFSET_DOTS;
      if (headCol >= HEAD_WIDTH_DOTS) break;
      if (rows[r][c]) headRow[Math.floor(headCol / 8)] |= 0x80 >> (headCol % 8);
    }
    buf.push(...headRow);
  }

  const remaining = PRINT_HEIGHT_DOTS - TOP_MARGIN_ROWS - contentRows;
  for (let i = 0; i < remaining; i++) buf.push(...blankRow);

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

// ─── BLE write with per-chunk ACK ─────────────────────────────────────────────

async function sendJob(
  writeChar: BluetoothRemoteGATTCharacteristic,
  ackChar: BluetoothRemoteGATTCharacteristic,
  job: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < job.length) {
    const chunk = job.slice(offset, offset + CHUNK_SIZE);
    offset += CHUNK_SIZE;

    // Wait for ACK before sending next chunk
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ackChar.removeEventListener('characteristicvaluechanged', handler);
        reject(new Error('Printer ACK timeout'));
      }, 5000);

      function handler(event: Event) {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value!;
        if (value && value.byteLength === 2 && value.getUint8(0) === 0x01 && value.getUint8(1) === 0x01) {
          clearTimeout(timeout);
          ackChar.removeEventListener('characteristicvaluechanged', handler);
          resolve();
        }
      }

      ackChar.addEventListener('characteristicvaluechanged', handler);
      writeChar.writeValueWithoutResponse(chunk).catch((err) => {
        clearTimeout(timeout);
        ackChar.removeEventListener('characteristicvaluechanged', handler);
        reject(err);
      });
    });
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
