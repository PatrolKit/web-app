// Web Bluetooth transport for the Phomemo M110.
//
// Transport only: connect, write bytes, disconnect. Layout lives on the server
// (apps/api/src/ski-swap/printing), and this file writes whatever it is handed.
// It used to render its own labels, and the two renderers drifted on head width
// — which shows up as tags that will not scan. One renderer, two transports.

// ─── BLE constants ────────────────────────────────────────────────────────────

/**
 * Where printing happens: write to FF02, per-chunk acknowledgements on FF03.
 *
 * Both printers expose this once connected — it is what `connectDevice` opens
 * and what the M221 prints through. What differs is whether they *advertise* it.
 */
const PHOMEMO_SERVICE = '0000ff00-0000-1000-8000-00805f9b34fb';
const WRITE_CHAR      = '0000ff02-0000-1000-8000-00805f9b34fb';
const ACK_CHAR        = '0000ff03-0000-1000-8000-00805f9b34fb'; // per-chunk ACK notifications

/**
 * What an M221 puts in its advertisement, where an M110 puts `FF00`.
 *
 * Read off the hardware with LightBlue: an M221 advertises `AF30` and `1812` and
 * not `FF00` — so a picker filtered on the service it prints through never
 * listed it, and the printer looked absent rather than unmatched. It still has
 * `FF00`; it just does not announce it.
 *
 * `1812` is standard HID and is deliberately not here — every keyboard and mouse
 * in the room advertises it, so filtering on it is barely a filter. `AF30` is
 * vendor-specific and selective.
 *
 * Nothing reads or writes this service. It exists to be advertised, which is all
 * a picker needs.
 */
const PHOMEMO_ADVERTISED_ALT = '0000af30-0000-1000-8000-00805f9b34fb';

/** Filters that list a printer of either kind, by whatever each one announces. */
export const PRINTER_ADVERTISED_FILTERS: BluetoothLEScanFilter[] = [
  { services: [PHOMEMO_SERVICE as BluetoothServiceUUID] },
  { services: [PHOMEMO_ADVERTISED_ALT as BluetoothServiceUUID] },
];

/** Bytes per BLE write. The printer's buffer, not ours. */
const CHUNK_SIZE = 182;

// ─── Printer configuration the UI edits ───────────────────────────────────────
// Mirrors the server's geometry.ts. These describe a printer, not a label: the
// UI needs them to render its margin controls, and sends them back as config.

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

/**
 * The printers and stock the server knows how to render for.
 *
 * Mirrors `apps/api/src/ski-swap/printing/geometry.ts` — the two cannot import
 * from each other, so this is the one place the web restates it. Everything else
 * in the app derives from here rather than writing the union out again, which is
 * what let a size be declared in eight places and updated in seven.
 *
 * `models` decides which sizes a printer may be offered: stock wider than the
 * head is unprintable, so a 62 × 100 roll is not an option on an M110.
 */
export const PRINTER_MODELS = ['m110', 'm221'] as const;
export type PrinterModelId = typeof PRINTER_MODELS[number];

export const PRINTER_MODEL_LABELS: Record<PrinterModelId, string> = {
  m110: 'Phomemo M110',
  m221: 'Phomemo M221',
};

export const PAPER_SIZES = ['50x30', '62x100', '25x67'] as const;
export type PaperSize = typeof PAPER_SIZES[number];

export const PAPER_SIZE_LABELS: Record<PaperSize, string> = {
  '50x30': '50 × 30 mm',
  '62x100': '62 × 100 mm',
  // The iPad prints to this stock directly; the server draws nothing on it, so
  // printing from the web to a printer set to it is refused.
  '25x67': '25 × 67 mm (iPad only)',
};

const PAPER_SIZE_MODELS: Record<PaperSize, readonly PrinterModelId[]> = {
  '50x30': ['m110'],
  '62x100': ['m221'],
  '25x67': ['m221'],
};

/** The stock this model can take, in declaration order. */
export function paperSizesFor(model: PrinterModelId): PaperSize[] {
  return PAPER_SIZES.filter((s) => PAPER_SIZE_MODELS[s].includes(model));
}

/**
 * Phomemos do not say what they are.
 *
 * Both printers we own advertise an opaque serial — `Q192E28B1060137` is an
 * M110 and `Q454E62S2530017` is an M221 — so there was a
 * `modelFromBluetoothName` here that never once fired. The model is asked for
 * instead, which is a dropdown against the label on the hardware and honest
 * about the fact that nothing else knows.
 */

// ─── Browser support guard ────────────────────────────────────────────────────

export function isWebBluetoothSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

// ─── Connected printer handle ─────────────────────────────────────────────────

export interface ConnectedM110 {
  device: BluetoothDevice;
  bluetoothName: string;
  /** Writes a finished ESC/POS job, as returned by the server's renderer. */
  write(job: Uint8Array): Promise<void>;
  disconnect(): void;
}

// ─── BLE write with sliding-window ACK ───────────────────────────────────────
// Send up to WINDOW chunks ahead of acknowledgements so the printer buffer stays
// full and the paper motor never stalls waiting for data.

const WINDOW = 3; // chunks in-flight before pausing for ACKs

/**
 * How long to wait for the acknowledgements a job is owed.
 *
 * Five seconds was fixed, and fine while every job was a 30 mm label — about
 * 12 KB and a second of paper. A 62 × 100 label is 60 KB, which is five times
 * the bytes over the same radio and three times the paper to pull through, and a
 * deadline that does not know the difference will fire on the larger one while
 * the printer is still working.
 *
 * Scaled by the job, floored at the old value so nothing changes for the labels
 * that already worked, and capped so a printer that has genuinely stopped
 * answering still fails rather than hanging.
 */
function ackDeadlineMs(jobBytes: number): number {
  return Math.min(30_000, Math.max(5_000, Math.round(jobBytes * 0.4)));
}

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
          const deadline = Date.now() + ackDeadlineMs(job.length);
          function poll() {
            if (ackCount >= sentCount - WINDOW + 1) { resolve(); return; }
            if (Date.now() > deadline) {
              reject(new Error(
                `The printer stopped acknowledging ${Math.round((offset / job.length) * 100)}% of the ` +
                `way through a ${Math.round(job.length / 1024)} KB label ` +
                `(${ackCount} of ${sentCount} chunks acknowledged).`,
              ));
              return;
            }
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

    // Drain remaining ACKs. This is the one that waits for paper: the last
    // chunks are acknowledged as the label physically prints.
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + ackDeadlineMs(job.length);
      function drain() {
        if (ackCount >= sentCount) { resolve(); return; }
        if (Date.now() > deadline) {
          reject(new Error(
            `The printer took every byte of a ${Math.round(job.length / 1024)} KB label but ` +
            `acknowledged ${ackCount} of ${sentCount} chunks. It may still be printing.`,
          ));
          return;
        }
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
    async write(job: Uint8Array): Promise<void> {
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
  const filters: BluetoothLEScanFilter[] = allowedBtNames.length > 0
    ? allowedBtNames.map((name) => ({ name }))
    : PRINTER_ADVERTISED_FILTERS;

  const device = await navigator.bluetooth.requestDevice({
    filters,
    optionalServices: [PHOMEMO_SERVICE],
  });
  return connectDevice(device);
}

/** Show the native BLE picker and connect. Requires a user gesture. */
/** Show the native BLE picker, filtered to this printer, and connect. */
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
