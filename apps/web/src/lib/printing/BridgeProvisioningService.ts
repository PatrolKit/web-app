// Web Bluetooth provisioning for the ESP-32 print bridge.
//
// Implements the GATT contract in webprinter_esp32/docs/PROVISIONING.md. The
// UUIDs and payloads are the firmware's, not ours — change them there first.
//
// Writes are staged on the board and applied atomically at commit, and staging
// is seeded from stored config on connect, so a partial re-provision (a new
// printer, say) keeps the fields it did not write.

const BASE = '-4b3d-4f6e-9c21-5d8e3f0a7b12';

export const BRIDGE_SERVICE = `7a1c0000${BASE}`;
const WIFI_SSID = `7a1c0001${BASE}`;
const WIFI_PSK = `7a1c0002${BASE}`;
const PRINTER_NAME = `7a1c0003${BASE}`;
const SERVER_CONFIG = `7a1c0004${BASE}`;
const COMMIT = `7a1c0005${BASE}`;
const STATUS = `7a1c0006${BASE}`;

const COMMIT_APPLY = 0x01;

/** What the board reports about itself, readable in every state including locked. */
export interface BridgeStatus {
  state: 'unprovisioned' | 'wifi_connecting' | 'server_connecting' | 'online';
  /** Provisioned *and* verified — every provisioning write is refused from here on. */
  locked: boolean;
  ssid?: string;
  printer?: string;
  printerLink?: 'ready' | 'down';
  wifi?: boolean;
  server?: boolean;
  printed?: number;
  failed?: number;
  device?: string;
}

export interface BridgeProvisioningInput {
  ssid: string;
  /** Empty for an open network. */
  psk: string;
  /** The Phomemo's advertised BLE name — the printer this bridge will drive. */
  printerBluetoothName: string;
  /** Origin only. The firmware appends /api/v1 itself, and rejects non-https. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Raised when the board has already been provisioned and verified.
 *
 * The lock is the only thing protecting a deployed board — writes cross the air
 * in the clear — so it cannot be cleared remotely by design. Someone has to
 * hold the BOOT button.
 */
export class BridgeLockedError extends Error {
  constructor(public status: BridgeStatus | null) {
    super(
      'This bridge has already been provisioned and verified, so it refuses further changes. ' +
        'Hold its BOOT button for 5 seconds to factory reset it, then try again.',
    );
    this.name = 'BridgeLockedError';
  }
}

export function isWebBluetoothSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/**
 * The firmware refuses a commit whose baseUrl is not https, and it refuses it
 * *after* the credentials have already crossed the air — so check here, where
 * the message can still be useful.
 */
export function isProvisionableOrigin(baseUrl: string): boolean {
  return baseUrl.startsWith('https://');
}

/** Origin only: the firmware appends `/api/v1` to whatever it is given. */
export function currentBaseUrl(): string {
  return window.location.origin;
}

/**
 * Runs the whole flow: pick a board, write the four values, commit, and report
 * status until it is online.
 *
 * Resolves once the board reports `online` — Wi-Fi joined, TLS worked, and the
 * server accepted its credentials. That last step is also what latches the
 * board closed, so reaching it means provisioning is finished for good.
 */
export async function provisionBridge(
  input: BridgeProvisioningInput,
  onStatus?: (status: BridgeStatus) => void,
  { timeoutMs = 90_000 }: { timeoutMs?: number } = {},
): Promise<BridgeStatus> {
  if (!isWebBluetoothSupported()) {
    throw new Error('Provisioning a bridge requires Chrome or Edge.');
  }
  if (!isProvisionableOrigin(input.baseUrl)) {
    throw new Error(
      `The bridge refuses anything but https, and this page is served from ${input.baseUrl}. ` +
        'Provision from the deployed site rather than a local dev server.',
    );
  }

  const device = await navigator.bluetooth.requestDevice({
    // Boards advertise the service; the PK-Print- name prefix is a fallback for
    // scanners that do not surface service UUIDs.
    filters: [{ services: [BRIDGE_SERVICE] }, { namePrefix: 'PK-Print-' }],
    optionalServices: [BRIDGE_SERVICE],
  });

  const gatt = await device.gatt!.connect();
  try {
    const service = await gatt.getPrimaryService(BRIDGE_SERVICE);
    const status = await service.getCharacteristic(STATUS);

    let latest: BridgeStatus | null = await readStatus(status);
    onStatus?.(latest!);

    // A locked board refuses every write. Saying so now beats discovering it
    // one failed write at a time.
    if (latest?.locked) throw new BridgeLockedError(latest);

    const reachedOnline = watchStatus(status, (s) => { latest = s; onStatus?.(s); });

    const enc = new TextEncoder();
    const write = async (uuid: string, bytes: BufferSource) =>
      (await service.getCharacteristic(uuid)).writeValue(bytes);

    try {
      await write(WIFI_SSID, enc.encode(input.ssid));
      await write(WIFI_PSK, enc.encode(input.psk));
      await write(PRINTER_NAME, enc.encode(input.printerBluetoothName));
      await write(SERVER_CONFIG, enc.encode(JSON.stringify({
        baseUrl: input.baseUrl,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
      })));
      await write(COMMIT, Uint8Array.of(COMMIT_APPLY));
    } catch (err) {
      // A refused write on a board that looks fine is almost always the lock.
      const now = await readStatus(status).catch(() => null);
      if (now?.locked) throw new BridgeLockedError(now);
      throw err;
    }

    return await reachedOnline(timeoutMs);
  } finally {
    // Leave the radio free for the next board rather than holding the link.
    device.gatt?.disconnect();
  }
}

async function readStatus(ch: BluetoothRemoteGATTCharacteristic): Promise<BridgeStatus | null> {
  try {
    return decodeStatus(await ch.readValue());
  } catch {
    return null;
  }
}

/**
 * Subscribes to status and hands back a function that waits for `online`.
 *
 * The board takes a few seconds to join Wi-Fi and reach the server, and the
 * notifications are the only view of which step it is on — a failure otherwise
 * looks identical to a slow success.
 */
function watchStatus(
  ch: BluetoothRemoteGATTCharacteristic,
  onStatus: (s: BridgeStatus) => void,
): (timeoutMs: number) => Promise<BridgeStatus> {
  let resolveOnline: ((s: BridgeStatus) => void) | null = null;

  const listener = (event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    const parsed = decodeStatus(value);
    if (!parsed) return;
    onStatus(parsed);
    if (parsed.state === 'online') resolveOnline?.(parsed);
  };

  const started = ch.startNotifications().then(() => {
    ch.addEventListener('characteristicvaluechanged', listener);
  });

  return async (timeoutMs: number) => {
    await started;
    try {
      return await new Promise<BridgeStatus>((resolve, reject) => {
        resolveOnline = resolve;
        setTimeout(() => {
          reject(new Error(
            'The bridge did not come online. Check the Wi-Fi name and password, ' +
              'and that this network can reach the internet.',
          ));
        }, timeoutMs);
      });
    } finally {
      ch.removeEventListener('characteristicvaluechanged', listener);
      await ch.stopNotifications().catch(() => {});
    }
  };
}

function decodeStatus(value: DataView): BridgeStatus | null {
  try {
    return JSON.parse(new TextDecoder().decode(value)) as BridgeStatus;
  } catch {
    return null;
  }
}
