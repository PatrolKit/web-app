// Web Bluetooth for the Inateck BCST-23 barcode scanner.
//
// Its own file rather than more of PhomemoPrinterService, because the two share
// exactly one thing — the short UUID FF00, which is the Phomemo's print service
// on one peripheral and the scanner's command service on another — and nothing
// else. Keeping them together only invited that collision to be read as kinship.
//
// The browser talks to a scanner exactly once, while provisioning it, to give it
// a name of ours. Every scan after that goes scanner → bridge → server, and the
// web UI is nowhere in that path.

// ─── GATT ────────────────────────────────────────────────────────────────────

/** Barcode data. On the scanner's GATT, but *not* in its advertisement. */
export const SCANNER_DATA_SERVICE = '000018f0-0000-1000-8000-00805f9b34fb' as BluetoothServiceUUID;

/** Battery, read on connect by the bridge rather than here. */
export const SCANNER_BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb' as BluetoothServiceUUID;

/** Beep, LED and settings. Shares its short UUID with the Phomemo print service. */
export const SCANNER_COMMAND_SERVICE = '0000ff00-0000-1000-8000-00805f9b34fb' as BluetoothServiceUUID;

/** Where command frames go. Write-without-response only — there is no long write. */
const SCANNER_COMMAND_WRITE = '0000ff04-0000-1000-8000-00805f9b34fb' as BluetoothCharacteristicUUID;

/**
 * What a scanner is called before anybody has renamed it.
 *
 * Used to reassure rather than to filter — a list that hid everything else would
 * hide a scanner that had already been renamed. `BCST-23` never goes over the
 * air at all; `HPRT` is the OEM's name, not Inateck's.
 */
export const SCANNER_FACTORY_NAME_PREFIX = 'HPRT';

// ─── The name we give a scanner ──────────────────────────────────────────────

/**
 * Minted at provisioning, written to the hardware, and never derived from
 * anything a person typed.
 *
 * It has to be this way. The only field both sides of provisioning can see is
 * the advertised name: the browser deliberately never exposes a MAC address —
 * `BluetoothDevice.id` is an opaque per-origin, per-profile token, so the same
 * scanner provisioned from a second laptop is a different `id` — and the bridge
 * has no other handle either. Unlike the printer, which caches an address after
 * resolving a name once, `scanner_ble.c` re-scans for its target by advertised
 * name on every reconnect. The name is the identity, permanently.
 *
 * So it carries as much randomness as the 20-byte ceiling allows and nothing
 * else. A literal UUIDv4 is 122 bits and does not fit in 20 printable bytes
 * under any encoding; 13 characters of base32 carry 64, which puts a collision
 * across ten thousand scanners at roughly 3e-12. The server's unique constraint
 * on `bluetoothName` is what actually decides it.
 */
export const SCANNER_NAME_PREFIX = 'pkscan_';

/** Inateck documents 20; the encoder does not enforce it, so we do. */
export const SCANNER_NAME_MAX_BYTES = 20;

const RANDOM_CHARS = SCANNER_NAME_MAX_BYTES - SCANNER_NAME_PREFIX.length;

/** Crockford's alphabet: no `i`, `l`, `o` or `u`, because this gets read off a console log. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

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
 * Give a scanner the name it will answer to for the rest of its life.
 *
 * **This cannot be verified from here, and that is worth knowing.** A write
 * that the scanner ignores looks exactly like one it accepted: FF04 takes no
 * response, replies arrive on FF01 in a format nobody has published, and the
 * browser cannot watch advertisements to read the new name back — Chrome still
 * lists advertisement scanning as unshipped. What this function detects is a
 * GATT failure. What it cannot detect is a silent refusal, which surfaces later
 * as a bridge reporting `scannerLink: down` because it is scanning for a name
 * nothing is advertising. The answer to that is to provision the scanner again.
 *
 * Renaming also drops any existing pairing: Inateck's manual requires the host
 * to delete its pairing record before the new name appears. So the link is torn
 * down here deliberately rather than left for the caller to trip over.
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
    if (device.gatt?.connected) device.gatt.disconnect();
  }
}

// ─── The picker ──────────────────────────────────────────────────────────────

/**
 * Shows the BLE picker and returns what was chosen.
 *
 * **Unfiltered, and it has to be.** A `filters` entry matches only against
 * services in the *advertisement*, and the BCST-23 advertises none of its own —
 * `18F0` exists on the peripheral but is discoverable only after connecting. A
 * service filter therefore matched nothing at all, which is why a scanner sat on
 * the bench and never appeared. The iOS app scans `withServices: nil` for the
 * same reason.
 *
 * Filtering by name was the other option and is worse: a factory-reset unit
 * advertises `HPRT`, so a scanner someone had already renamed would vanish from
 * the list with no clue why. Provisioning happens once, in a back room, so a
 * longer list is the cheaper failure.
 *
 * The device itself comes back, not just its name: renaming needs the same
 * object, and sending the operator through a second picker to reach it would be
 * a second chance to choose the wrong device.
 */
export async function scanForScanner(): Promise<{ device: BluetoothDevice; bluetoothName: string }> {
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [
      SCANNER_DATA_SERVICE,
      SCANNER_BATTERY_SERVICE,
      SCANNER_COMMAND_SERVICE,
    ],
  });
  return { device, bluetoothName: device.name ?? '' };
}
