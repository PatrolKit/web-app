// Web Bluetooth transport for the Phomemo M110.
//
// Transport only: connect, write bytes, disconnect. Layout lives on the server
// (apps/api/src/ski-swap/printing), and this file writes whatever it is handed.
// It used to render its own labels, and the two renderers drifted on head width
// — which shows up as tags that will not scan. One renderer, two transports.

// ─── BLE constants ────────────────────────────────────────────────────────────

const PHOMEMO_SERVICE = '0000ff00-0000-1000-8000-00805f9b34fb';
const WRITE_CHAR      = '0000ff02-0000-1000-8000-00805f9b34fb';
const ACK_CHAR        = '0000ff03-0000-1000-8000-00805f9b34fb'; // per-chunk ACK notifications

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

export const PAPER_SIZES = ['50x30', '62x100'] as const;
export type PaperSize = typeof PAPER_SIZES[number];

export const PAPER_SIZE_LABELS: Record<PaperSize, string> = {
  '50x30': '50 × 30 mm',
  '62x100': '62 × 100 mm',
};

const PAPER_SIZE_MODELS: Record<PaperSize, readonly PrinterModelId[]> = {
  '50x30': ['m110'],
  '62x100': ['m221'],
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
/**
 * Shows the BLE picker and connects. Requires a user gesture.
 *
 * `anyDevice` drops the name filter. The filtered picker only ever lists a
 * device advertising exactly the stored name, so it comes up empty both when the
 * printer is asleep and when the name it advertises has stopped matching what we
 * recorded — and an empty list is indistinguishable from a cancelled one. The
 * wide list separates those: if the printer is there under another name, the
 * name is wrong; if it is not there at all, the radio is.
 */
export async function connectPrinter(
  bluetoothName: string,
  { anyDevice = false }: { anyDevice?: boolean } = {},
): Promise<ConnectedM110> {
  const device = await navigator.bluetooth.requestDevice(
    anyDevice
      ? { acceptAllDevices: true, optionalServices: [PHOMEMO_SERVICE] }
      : { filters: [{ name: bluetoothName }], optionalServices: [PHOMEMO_SERVICE] },
  );
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
