// Web Bluetooth for the Inateck BCST-23 barcode scanner.
//
// Its own file rather than more of PhomemoPrinterService, because the two share
// exactly one thing — the short UUID FF00, which is the Phomemo's print service
// on one peripheral and the scanner's command service on another — and nothing
// else. Keeping them together only invited that collision to be read as kinship.
//
// **In service, the browser does not talk to a scanner.** It shows a picker and
// reads the advertised name; the bridge holds the link, and every scan goes
// scanner → bridge → server with the web UI nowhere in that path. The one
// exception is the scanner test, which connects directly while the scanner is
// off its bridge — see "Reading scans".
//
// It was supposed to do one more thing — rename the scanner at provisioning, so
// the name was ours rather than whatever it shipped with. That did not work on
// hardware. The attempt is parked at the bottom of this file rather than deleted,
// because the frame format underneath it is verified and someone will want it.

// ─── GATT ────────────────────────────────────────────────────────────────────

/** Barcode data. On the scanner's GATT, but *not* in its advertisement. */
export const SCANNER_DATA_SERVICE = '000018f0-0000-1000-8000-00805f9b34fb' as BluetoothServiceUUID;

/** Battery, read on connect by the bridge rather than here. */
export const SCANNER_BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb' as BluetoothServiceUUID;

/** Beep, LED and settings. Shares its short UUID with the Phomemo print service. */
export const SCANNER_COMMAND_SERVICE = '0000ff00-0000-1000-8000-00805f9b34fb' as BluetoothServiceUUID;

/** Where command frames go. Write-without-response only — there is no long write. */
const SCANNER_COMMAND_WRITE = '0000ff04-0000-1000-8000-00805f9b34fb' as BluetoothCharacteristicUUID;

// ─── The names a scanner can have ────────────────────────────────────────────

/**
 * What a scanner calls itself, and — for now — what we record it under.
 *
 * `HPRT` is the OEM's name, not Inateck's: `BCST-23` never goes over the air at
 * all, which is why the model number is no use for finding one.
 *
 * Whether this is unique per unit is the question the whole provisioning story
 * turns on, and it is the hardware's answer to give, not ours. If two scanners
 * advertise the same thing, the second one cannot be added — the server refuses
 * a duplicate `bluetoothName` and names the row already holding it.
 */
export const SCANNER_FACTORY_NAME_PREFIX = 'HPRT';

/**
 * The prefix a scanner would carry if we named it ourselves.
 *
 * Nothing wears this today — see "Renaming a scanner" at the foot of this file.
 * It stays in the filter so that a scanner named by hand, or by some later
 * provisioning step that does work, is selectable the day it exists rather than
 * needing this shipped first.
 */
export const SCANNER_NAME_PREFIX = 'pkscan_';

/**
 * Every name a scanner of ours can be advertising, and the whole of the picker's
 * filter. Case-sensitive, because `namePrefix` is.
 */
export const SCANNER_NAME_PREFIXES = [SCANNER_FACTORY_NAME_PREFIX, SCANNER_NAME_PREFIX] as const;

// ─── The picker ──────────────────────────────────────────────────────────────

/**
 * Shows the BLE picker and returns what was chosen.
 *
 * **Filtered on the name, and only on the name.** A `filters` entry matches
 * services in the *advertisement*, and the BCST-23 advertises none of its own —
 * `18F0` is on the peripheral but discoverable only after connecting, so a
 * service filter matched nothing at all and a scanner on the bench never
 * appeared. `namePrefix` is the one condition that does work, because the name
 * is in the advertisement.
 *
 * What this costs: a scanner outside those prefixes is unreachable from here
 * rather than merely hard to spot. That is the trade — a device answering to
 * neither name is not one this code can account for.
 *
 * The device itself comes back, not just its name. Nothing uses it today, but a
 * caller that wants to talk to the scanner needs the same object the picker
 * granted permission for, and sending the operator through a second picker to
 * reach it would be a second chance to choose the wrong device.
 */
export async function scanForScanner(): Promise<{ device: BluetoothDevice; bluetoothName: string }> {
  const device = await navigator.bluetooth.requestDevice({
    filters: SCANNER_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
    optionalServices: [
      SCANNER_DATA_SERVICE,
      SCANNER_BATTERY_SERVICE,
      SCANNER_COMMAND_SERVICE,
    ],
  });
  return { device, bluetoothName: device.name ?? '' };
}

/**
 * The picker, narrowed to one scanner by the exact name it advertises, for when
 * the page already knows which one it wants — testing a scanner on the list.
 */
export async function pickScannerNamed(bluetoothName: string): Promise<BluetoothDevice> {
  return navigator.bluetooth.requestDevice({
    filters: [{ name: bluetoothName }],
    optionalServices: [SCANNER_DATA_SERVICE, SCANNER_BATTERY_SERVICE, SCANNER_COMMAND_SERVICE],
  });
}

// ─── Reading scans ───────────────────────────────────────────────────────────
//
// Only the scanner test reads scans in the browser: in service, the bridge holds
// the link. The decoding is a port of the firmware's `scan_decoder.c`, itself a
// port of the iPad's `ScanDecoder.swift`, and must stay identical to both — a
// test that decoded more forgivingly than the bridge would pass a scanner the
// bridge then misreads.

/** Barcode notifications, in fragments. */
const SCANNER_DATA_NOTIFY = '00002af0-0000-1000-8000-00805f9b34fb' as BluetoothCharacteristicUUID;

/** Ends each barcode. Anything else is buffered until one arrives. */
const SCAN_TERMINATOR = '\r';

/** The firmware's buffer: a barcode longer than this is discarded whole, not truncated. */
const SCAN_BUFFER_MAX = 512;

/** And its payload ceiling, which only a runaway QR could reach. */
const SCAN_PAYLOAD_MAX = 255;

/**
 * Which kind of code was read, from the one-character id the scanner prepends.
 * Case matters: 'a' is Code-128 and 'A' is QR.
 */
export type ScanSymbology = 'code39' | 'code128' | 'qr' | 'unknown';

export interface Scan {
  symbology: ScanSymbology;
  /** The leading character when it was not an id we know — nothing was stripped then. */
  unknownId?: string;
  payload: string;
}

const CODE_IDS: Record<string, ScanSymbology> = { f: 'code39', a: 'code128', A: 'qr' };

/** One terminated segment to a scan, or null when it is only whitespace. Exported for the tests. */
export function decodeScanSegment(segment: string): Scan | null {
  const trimmed = segment.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, '');
  if (!trimmed) return null;
  const id = trimmed[0];
  const symbology = CODE_IDS[id];
  // Not an id we know means code-id output is off on the scanner. Keep the
  // character: stripping it on a guess is how every SKU loses its first letter.
  if (!symbology) return { symbology: 'unknown', unknownId: id, payload: trimmed.slice(0, SCAN_PAYLOAD_MAX) };
  return { symbology, payload: trimmed.slice(1, 1 + SCAN_PAYLOAD_MAX) };
}

/** Whole barcodes out of notification fragments, one or several per notification. */
export class ScanDecoder {
  private buf = '';
  private overflowed = false;

  ingest(bytes: Uint8Array): Scan[] {
    const scans: Scan[] = [];
    for (const byte of bytes) {
      const c = String.fromCharCode(byte);
      if (c === SCAN_TERMINATOR) {
        const scan = this.overflowed ? null : decodeScanSegment(this.buf);
        if (scan) scans.push(scan);
        this.buf = '';
        this.overflowed = false;
      } else if (this.buf.length < SCAN_BUFFER_MAX) {
        this.buf += c;
      } else {
        this.overflowed = true;
      }
    }
    return scans;
  }
}

/**
 * Connects to a scanner and hands each whole barcode to `onScan`, until the
 * returned function is called.
 *
 * Only works while the scanner is free. A scanner holds one link, and one held
 * by its bridge means it is not advertising, so the picker never showed it.
 */
export async function listenForScans(
  device: BluetoothDevice,
  onScan: (scan: Scan) => void,
  onDisconnect?: () => void,
): Promise<() => void> {
  if (!device.gatt) throw new Error('That device exposes no GATT server, so it cannot be a scanner.');
  const server = await device.gatt.connect();
  const decoder = new ScanDecoder();
  const data = await (await server.getPrimaryService(SCANNER_DATA_SERVICE)).getCharacteristic(SCANNER_DATA_NOTIFY);

  const onValue = (event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    for (const scan of decoder.ingest(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))) onScan(scan);
  };
  const onGone = () => onDisconnect?.();
  data.addEventListener('characteristicvaluechanged', onValue);
  device.addEventListener('gattserverdisconnected', onGone);
  await data.startNotifications();

  return () => {
    data.removeEventListener('characteristicvaluechanged', onValue);
    device.removeEventListener('gattserverdisconnected', onGone);
    if (device.gatt?.connected) device.gatt.disconnect();
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Renaming a scanner — parked, and not wired to anything
// ═════════════════════════════════════════════════════════════════════════════
//
// None of what follows runs. It was built to give a scanner a name of ours at
// provisioning, on the reasoning that the advertised name is the only handle a
// bridge has: the browser never exposes a MAC — `BluetoothDevice.id` is an
// opaque per-origin token — and `scanner_ble.c` re-scans for its target by
// advertised name on every reconnect.
//
// **It was tried on hardware and the scanner did not take the name.** The writes
// were accepted and nothing came back to say otherwise, which is the failure
// mode the code below already warned about: FF04 takes no response, FF01's reply
// format is unpublished, and Chrome has not shipped advertisement scanning, so
// there is no way from a browser to read the new name back.
//
// What is still worth something here, and why this is parked rather than deleted:
//
//   - `buildSetName` reproduces four frames Inateck's own encoder emitted, byte
//     for byte, and the tests hold it to them. The frame format is not in doubt.
//   - `AUTH_FRAME` carries across from the firmware's `SCANNER_AUTH_FRAME` and
//     verifies against its own checksum.
//
// So the encoding is not where this failed. Candidates for where it did, none of
// them established: the auth frame being rejected rather than merely unanswered;
// 20-byte chunks arriving too fast, or too slowly, for the scanner's reassembly;
// a commit or save step the library performs that we did not capture; or the
// rename simply not being reachable over BLE on this firmware, with the
// programming barcodes in the manual being the only route. The firmware team has
// the same frames and a wired console, which is a better place to find out.

// ─── Minting a name ──────────────────────────────────────────────────────────

/** Inateck documents 20; the encoder does not enforce it, so we do. */
export const SCANNER_NAME_MAX_BYTES = 20;

const RANDOM_CHARS = SCANNER_NAME_MAX_BYTES - SCANNER_NAME_PREFIX.length;

/** Crockford's alphabet: no `i`, `l`, `o` or `u`, because this gets read off a console log. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * As much randomness as the 20-byte ceiling allows, and nothing else.
 *
 * A literal UUIDv4 is 122 bits and does not fit in 20 printable bytes under any
 * encoding; 13 characters of base32 carry 64, which puts a collision across ten
 * thousand scanners at roughly 3e-12.
 */
export function mintScannerName(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);

  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);

  let out = '';
  for (let i = 0; i < RANDOM_CHARS; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return SCANNER_NAME_PREFIX + out;
}

// ─── Command frames ──────────────────────────────────────────────────────────
//
//     [type][len][0x7F][cmd][params...][checksum]
//
//     type      0xF1 auth, 0xF2 get, 0xF3 set
//     len       bytes between len and checksum
//     checksum  low byte of the sum of every preceding byte
//
// Taken from the manufacturer's own encoder rather than guessed, and mirrored in
// the firmware's scanner_cmd.h, which is the other implementation of this.

const FRAME_SET = 0xf3;
const FRAME_MARKER = 0x7f;
const CMD_SET_NAME = 0x40;

/**
 * The auth handshake, emitted verbatim by the manufacturer's encoder.
 *
 * A fixed application identity and signature, so it is a constant rather than
 * anything we can compute. It goes first: commands sent without it are silently
 * discarded, which is a failure mode with no symptom at all.
 *
 * Base64 of the 294 bytes in webprinter_esp32's `SCANNER_AUTH_FRAME`, extracted
 * rather than retyped. Its own trailing checksum verifies it.
 */
const AUTH_FRAME_B64 =
  '8QEiY29tLmJldGEuc2Nhbm5lcgBiZXRhNjk0YmU1NjI2ODZiAFF4eXIwVnBBcis2Mmt4WnJsQTY4' +
  'MU5TQkVIV0gwd3BvcFhhckRnZzc1bEZIZUxkUzRQWHZPOUVhamFaNjNoYXo3U3N6M2lPamM5YkNT' +
  'L09jcm1CdnhCRWcvc2M3cGNmOE5zYUR0c0E1THAyZlllbkV3dUhrQ3pVblp1dDgzRVRrUkR1VnFs' +
  'ZjA0UUJjREEyZGo3MDlSNUFHVHhBRkVYSk84Vitzb0VOWEU3MVNUZ213U2UyZElEdzEwWUtSSExj' +
  'UnNmNTc5RC9RQ1BlQThremRMTXRyNjJBMlJ0UlN5VlBoRDBTTjJBRHpFeXh4aVBCemMzL0o2K2VI' +
  'ckNDL21TZ1Ov';

export const AUTH_FRAME = Uint8Array.from(atob(AUTH_FRAME_B64), (c) => c.charCodeAt(0));

/**
 * Exported for the tests, which assert it against four frames the manufacturer's
 * own encoder produced. Those frames are the entire reason to believe any of
 * this — the format was read off a library, not a specification.
 */
export function buildSetName(name: string): Uint8Array {
  const body = new TextEncoder().encode(name);
  const frame = new Uint8Array(4 + body.length + 1);

  frame[0] = FRAME_SET;
  frame[1] = body.length + 2; // the marker, the opcode, and the name itself
  frame[2] = FRAME_MARKER;
  frame[3] = CMD_SET_NAME;
  frame.set(body, 4);

  let sum = 0;
  for (let i = 0; i < frame.length - 1; i++) sum += frame[i];
  frame[frame.length - 1] = sum & 0xff;

  return frame;
}

// ─── Writing them ────────────────────────────────────────────────────────────

/**
 * The smallest ATT payload any peer must accept.
 *
 * Web Bluetooth does not expose the negotiated MTU, and FF04 is
 * write-without-response only — so there is no long-write procedure to fall
 * back on when a frame overruns it. The auth frame is 294 bytes, so chunking is
 * the normal case. Twenty always fits; the scanner reassembles by frame length.
 */
const CHUNK = 20;

/** The firmware's pacing between chunks, which is known to work on this hardware. */
const CHUNK_GAP_MS = 15;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function writeFrame(chr: BluetoothRemoteGATTCharacteristic, frame: Uint8Array) {
  for (let off = 0; off < frame.length; off += CHUNK) {
    // `slice`, not `subarray`: a view with a non-zero byteOffset is handled
    // inconsistently across Web Bluetooth implementations.
    const part = frame.slice(off, Math.min(off + CHUNK, frame.length));

    if (typeof chr.writeValueWithoutResponse === 'function') {
      await chr.writeValueWithoutResponse(part);
    } else {
      // Older Chrome. FF04 has no write-with-response property, so this
      // resolves to the same ATT operation.
      await chr.writeValue(part);
    }

    if (off + CHUNK < frame.length) await sleep(CHUNK_GAP_MS);
  }
}

/**
 * Give a scanner a name of ours. Does not work — see the banner above.
 *
 * Kept callable so the next attempt starts from something that has been read,
 * built and type-checked rather than from a description of it.
 */
export async function renameScanner(device: BluetoothDevice, name: string): Promise<void> {
  const width = new TextEncoder().encode(name).length;
  if (width > SCANNER_NAME_MAX_BYTES) {
    throw new Error(`"${name}" is ${width} bytes; a scanner name can be at most ${SCANNER_NAME_MAX_BYTES}.`);
  }
  if (!device.gatt) {
    throw new Error('That device exposes no GATT server, so it cannot be a scanner.');
  }

  const server = await device.gatt.connect();
  try {
    const service = await server.getPrimaryService(SCANNER_COMMAND_SERVICE);
    const write = await service.getCharacteristic(SCANNER_COMMAND_WRITE);

    await writeFrame(write, AUTH_FRAME);
    await sleep(CHUNK_GAP_MS * 4); // let the scanner reassemble 294 bytes before the next frame
    await writeFrame(write, buildSetName(name));
    await sleep(CHUNK_GAP_MS * 4); // and commit it before the link goes away
  } finally {
    // Renaming was supposed to drop the pairing, so the link is torn down here
    // deliberately rather than left for a caller to trip over.
    if (device.gatt?.connected) device.gatt.disconnect();
  }
}
