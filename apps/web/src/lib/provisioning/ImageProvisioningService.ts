// Web Bluetooth provisioning for devices running the PatrolKit device image.
//
// Implements the GATT contract in patrolkit-device-image's BASE_IMAGE_PLAN §9.3.
// The UUIDs, payloads and gate are the image's, not ours — change them there
// first. Writes are staged on the device and applied atomically at commit, and
// staging is seeded from stored config when a connection unlocks, so a partial
// re-provision (a new Wi-Fi password, say) keeps the fields it did not write.
//
// Deliberately a second implementation rather than a generalisation of
// `printing/BridgeProvisioningService.ts`. The two protocols share a UUID family
// and put their common characteristics at identical offsets, but they disagree
// about the one thing a shared client would have to model: both refuse a write
// with ATT 0x03, and on a bridge that is terminal — someone must hold the BOOT
// button — while here it means "type the PIN on the screen". Getting that wrong
// tells a technician to factory-reset a display that needed six digits.

const BASE = '-4b3d-4f6e-9c21-5d8e3f0a7b12';

/**
 * The default service UUID, from `provisioning.ble.service_uuid`.
 *
 * Set per image at build time, so a device type built with a different one only
 * needs a different constant here — every characteristic is derived from it.
 */
export const IMAGE_SERVICE = `7a1c1000${BASE}`;

/** Characteristic offsets (§9.3). Slot `003` is the printer's and stays unused. */
const Slot = {
  WIFI_SSID: 0x001,
  WIFI_PSK: 0x002,
  SERVER_CONFIG: 0x004,
  COMMIT: 0x005,
  STATUS: 0x006,
  CONTROL: 0x010,
  PIN: 0x011,
  APP_PAYLOAD: 0x012,
  WIFI_SCAN: 0x013,
} as const;

const CONTROL_SHOW_PIN = 0x01;
const CONTROL_RESCAN = 0x02;
const COMMIT_APPLY = 0x01;
const COMMIT_FACTORY_RESET = 0xff;

/** Three strikes regenerate the PIN and start a cooldown (§9.4). */
const MAX_PIN_ATTEMPTS = 3;

/** `7a1c1000-…` + `0x011` → `7a1c1011-…`, the same arithmetic the device does. */
export function charUuid(serviceUuid: string, slot: number): string {
  const [head, ...rest] = serviceUuid.split('-');
  return `${head.slice(0, 5)}${slot.toString(16).padStart(3, '0')}-${rest.join('-')}`;
}

/** What the device reports about itself. Readable in every state, gate or no gate. */
export interface ImageStatus {
  state: 'unprovisioned' | 'wifi_connecting' | 'bootstrapping' | 'installing' | 'online';
  /**
   * True when *any* connection holds an unlock, not necessarily this one — the
   * device publishes a rollup. Treat it as a hint; whether a gated write
   * succeeds is the only reliable answer.
   */
  unlocked: boolean;
  pinDisplayed: boolean;
  /** A bench image mirroring its PIN to a file. Never true on anything shippable. */
  pinExposed?: boolean;
  device?: string;
  ssid?: string;
  wifi?: boolean;
  bootstrap?: boolean;
  imageVersion?: string;
  packages?: { name: string; version: string }[];
  timeSynced?: boolean;
  error?: string | null;
}

export interface WifiNetwork {
  ssid: string;
  rssi: number;
  security: string;
  hidden?: boolean;
}

export interface ImageProvisioningInput {
  ssid: string;
  /** Empty for an open network. */
  psk: string;
  /** Origin only, https. The device appends the API paths itself. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /**
   * Written to disk verbatim and never parsed by the base image (§3). It is the
   * only channel to the application, which is why the credentials appear here
   * as well as in `server_config` — every provisioning characteristic is
   * write-only, so an app cannot read back what the bootstrapper was given.
   */
  appPayload: Record<string, unknown>;
}

/**
 * A gated write was refused, which on this device type means the PIN.
 *
 * Solvable, unlike the print bridge's lock: the six digits are on the screen in
 * front of whoever is holding the laptop.
 */
export class PinRequiredError extends Error {
  constructor() {
    super('This device needs the PIN shown on its screen before it will accept changes.');
    this.name = 'PinRequiredError';
  }
}

/** The PIN was wrong. After the third try the device changes it. */
export class BadPinError extends Error {
  constructor(
    readonly attemptsRemaining: number,
    readonly lockedOut: boolean,
  ) {
    super(
      lockedOut
        ? 'Too many attempts. The device has locked provisioning for a minute and shown a new PIN — read it off the screen again.'
        : `That PIN was not accepted. ${attemptsRemaining} ${attemptsRemaining === 1 ? 'try' : 'tries'} left before the device changes it.`,
    );
    this.name = 'BadPinError';
  }
}

export function isWebBluetoothSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/**
 * The device refuses a `server_config` whose baseUrl is not https, and it
 * refuses it *after* the credentials have already crossed the air — so check
 * here, where the message can still be useful. Web Bluetooth needs a secure
 * context for its own reasons, so this is really one constraint wearing two
 * hats.
 */
export function isProvisionableOrigin(baseUrl: string): boolean {
  return baseUrl.startsWith('https://');
}

/** Origin only: the device appends `/api/v1` to whatever it is given. */
export function currentBaseUrl(): string {
  return window.location.origin;
}

/**
 * One connection to one device.
 *
 * A session rather than a single `provision()` call because the flow is
 * genuinely interactive: the screen has to be reclaimed before anyone can read
 * the PIN, and the Wi-Fi scan has to reach the form before it is submitted.
 */
export class ImageProvisioningSession {
  private pinAttempts = 0;
  private statusListeners = new Set<(s: ImageStatus) => void>();
  private latest: ImageStatus | null = null;

  private constructor(
    private readonly device: BluetoothDevice,
    private readonly service: BluetoothRemoteGATTService,
    private readonly status: BluetoothRemoteGATTCharacteristic,
  ) {}

  /** Picks a device, connects, and subscribes to status. */
  static async open(serviceUuid: string = IMAGE_SERVICE): Promise<ImageProvisioningSession> {
    if (!isWebBluetoothSupported()) {
      throw new Error('Setting up a display requires Chrome or Edge.');
    }

    const device = await navigator.bluetooth.requestDevice({
      // Devices advertise the service; the `PK-` name prefix is a fallback for
      // scanners that do not surface service UUIDs. The label between the
      // prefix and the serial is set per image, so it cannot be matched on.
      filters: [{ services: [serviceUuid] }, { namePrefix: 'PK-' }],
      optionalServices: [serviceUuid],
    });

    const gatt = await device.gatt!.connect();
    const service = await gatt.getPrimaryService(serviceUuid);
    const statusChar = await service.getCharacteristic(charUuid(serviceUuid, Slot.STATUS));

    const session = new ImageProvisioningSession(device, service, statusChar);
    await session.startWatchingStatus();
    return session;
  }

  onStatus(listener: (s: ImageStatus) => void): () => void {
    this.statusListeners.add(listener);
    if (this.latest) listener(this.latest);
    return () => this.statusListeners.delete(listener);
  }

  get currentStatus(): ImageStatus | null {
    return this.latest;
  }

  /**
   * Asks the device to take the screen back and show its PIN.
   *
   * Ungated by design — you cannot type a PIN you cannot see — and rate-limited
   * on the device, so an impatient second press is refused rather than queued.
   * Stopping the application to draw a PIN never depends on the application
   * cooperating; the base owns systemd and kills it if it will not yield.
   */
  async showPin(): Promise<void> {
    await this.write(Slot.CONTROL, Uint8Array.of(CONTROL_SHOW_PIN));
  }

  /**
   * Unlocks this connection. Authorisation does not outlive it: disconnect and
   * the next connection must present the PIN again.
   */
  async unlock(pin: string): Promise<void> {
    const digits = pin.replace(/\D/g, '');
    try {
      await this.write(Slot.PIN, new TextEncoder().encode(digits));
      this.pinAttempts = 0;
    } catch {
      // The device's own reason — "incorrect PIN, 2 remaining" versus "locked
      // out" — does not survive the browser's GATT error mapping, so the count
      // is kept here. It is the same count the device keeps, reset by the same
      // events, and it is only ever used to choose a sentence.
      this.pinAttempts += 1;
      const lockedOut = this.pinAttempts >= MAX_PIN_ATTEMPTS;
      if (lockedOut) this.pinAttempts = 0;
      throw new BadPinError(Math.max(0, MAX_PIN_ATTEMPTS - this.pinAttempts), lockedOut);
    }
  }

  /** Triggers a fresh scan and reads the result. Ungated, like `status`. */
  async rescan(): Promise<WifiNetwork[]> {
    await this.write(Slot.CONTROL, Uint8Array.of(CONTROL_RESCAN));
    // The scan is asynchronous on the device; the published value updates when
    // it finishes. A short settle beats a notification subscription for one read.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return this.readNetworks();
  }

  async readNetworks(): Promise<WifiNetwork[]> {
    try {
      const characteristic = await this.service.getCharacteristic(
        charUuid(this.serviceUuid, Slot.WIFI_SCAN),
      );
      const parsed = JSON.parse(new TextDecoder().decode(await characteristic.readValue()));
      return Array.isArray(parsed) ? (parsed as WifiNetwork[]) : [];
    } catch {
      // A device that cannot scan is still provisionable by typing an SSID, so
      // this is an empty list rather than a failure.
      return [];
    }
  }

  /**
   * Stages every field and commits. Returns as soon as the device accepts it.
   *
   * It deliberately does **not** wait for the device to come online, because on
   * a first install it never can: the device installs, seals, and reboots
   * itself, which drops this connection. Waiting here for `state: "online"`
   * waits for a notification from a radio that has been switched off — the
   * whole flow simply hung until it timed out, on a display that had in fact
   * worked. The print bridge has no equivalent step, which is how the
   * assumption came across unexamined.
   *
   * The signal that provisioning worked is the server hearing from the device.
   * That survives the reboot, proves the credentials and the network rather
   * than merely the write, and is what the caller should wait on. `status`
   * keeps streaming until the link drops and is worth showing as progress —
   * an error on it (a refused Wi-Fi password) is a fast, certain failure long
   * before any server-side timeout.
   */
  async commit(
    input: ImageProvisioningInput,
    { onCommitted }: { onCommitted?: () => void } = {},
  ): Promise<void> {
    if (!isProvisionableOrigin(input.baseUrl)) {
      throw new Error(
        `The device refuses anything but https, and this page is served from ${input.baseUrl}. ` +
          'Set displays up from the deployed site rather than a local dev server.',
      );
    }

    const encoder = new TextEncoder();
    await this.write(Slot.WIFI_SSID, encoder.encode(input.ssid));
    await this.write(Slot.WIFI_PSK, encoder.encode(input.psk));
    await this.write(
      Slot.SERVER_CONFIG,
      encoder.encode(
        JSON.stringify({
          baseUrl: input.baseUrl,
          clientId: input.clientId,
          clientSecret: input.clientSecret,
        }),
      ),
    );
    await this.write(Slot.APP_PAYLOAD, encoder.encode(JSON.stringify(input.appPayload)));

    // Everything above is staged; nothing has touched disk until this line.
    await this.write(Slot.COMMIT, Uint8Array.of(COMMIT_APPLY));
    onCommitted?.();
  }

  /**
   * Erases provisioning and bootstrap state and reboots into provisioning mode.
   * Installed packages are left alone and reconciled at the next check-in.
   *
   * PIN-gated like any other write, and — unlike the print bridge, which
   * disables remote wipe once locked — still available on a provisioned device.
   * It is how a display whose credentials were revoked gets a second life.
   */
  async factoryReset(): Promise<void> {
    await this.write(Slot.COMMIT, Uint8Array.of(COMMIT_FACTORY_RESET));
  }

  /** Leaves the radio free for the next unit rather than holding the link. */
  close(): void {
    this.statusListeners.clear();
    this.device.gatt?.disconnect();
  }

  private get serviceUuid(): string {
    return this.service.uuid;
  }

  private async write(slot: number, value: BufferSource): Promise<void> {
    const characteristic = await this.service.getCharacteristic(charUuid(this.serviceUuid, slot));
    try {
      await characteristic.writeValue(value);
    } catch (err) {
      // The browser flattens every ATT error into one DOMException, so the
      // device's own status is what distinguishes "you have not unlocked" from
      // "that write was malformed" — the same recovery the firmware docs
      // prescribe for the print bridge, for the same reason.
      const now = await this.readStatus().catch(() => null);
      if (now && !now.unlocked && slot !== Slot.PIN && slot !== Slot.CONTROL) {
        throw new PinRequiredError();
      }
      throw err;
    }
  }

  private async readStatus(): Promise<ImageStatus | null> {
    try {
      return decodeStatus(await this.status.readValue());
    } catch {
      return null;
    }
  }

  private async startWatchingStatus(): Promise<void> {
    this.latest = await this.readStatus();
    if (this.latest) this.publish(this.latest);

    await this.status.startNotifications();
    this.status.addEventListener('characteristicvaluechanged', (event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (!value) return;
      const parsed = decodeStatus(value);
      if (parsed) this.publish(parsed);
    });
  }

  private publish(status: ImageStatus): void {
    this.latest = status;
    for (const listener of this.statusListeners) listener(status);
  }

  /**
   * Called when the link drops.
   *
   * On a first install that is the device rebooting itself after sealing, which
   * is success rather than failure — so this reports the fact and lets the
   * caller decide what it means.
   */
  onDisconnect(listener: () => void): () => void {
    const handler = () => listener();
    this.device.addEventListener('gattserverdisconnected', handler);
    return () => this.device.removeEventListener('gattserverdisconnected', handler);
  }
}

/** The device's error codes, as something to read. */
export function describeError(code: string): string {
  switch (code) {
    case 'BAD_PIN':
      return 'The PIN was rejected.';
    case 'WIFI_AUTH_FAILED':
      return 'The Wi-Fi password was refused. Check it and try again.';
    case 'NO_SSID':
      return 'That network was not found. Check the name, and that it is in range of the display.';
    case 'CAPTIVE_PORTAL':
      return 'This network wants a sign-in page, which a display cannot fill in. It needs a network that does not.';
    case 'NO_INTERNET':
      return 'The display joined the network but could not reach the internet.';
    case 'BOOTSTRAP_FAILED':
      return 'The display could not ask the server what to run. Check that its credentials are still valid.';
    default:
      return `The display reported an error: ${code}`;
  }
}

/** How far along the device is, as something to read. */
export function describeState(status: ImageStatus): string {
  switch (status.state) {
    case 'unprovisioned':
      return 'Waiting to be set up';
    case 'wifi_connecting':
      return `Joining ${status.ssid ?? 'the network'}…`;
    case 'bootstrapping':
      return 'Asking the server what to run…';
    case 'installing':
      return 'Installing — this can take a few minutes';
    case 'online':
      return 'Online';
    default:
      return 'Working…';
  }
}

function decodeStatus(value: DataView): ImageStatus | null {
  try {
    return JSON.parse(new TextDecoder().decode(value)) as ImageStatus;
  } catch {
    return null;
  }
}
