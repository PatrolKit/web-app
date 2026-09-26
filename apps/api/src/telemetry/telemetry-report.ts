/**
 * Reading a telemetry report (webprinter_esp32 Plan 4) without trusting it.
 *
 * The firmware's one hard rule for this endpoint: never refuse a report over
 * its contents. Unknown fields are kept, a known field with the wrong type is
 * dropped from the columns and noted, and only a body that is not an object at
 * all is refused. A claim schema that refused unknown fields once took a bridge
 * offline, and telemetry gains fields more often than anything else.
 */

/**
 * Resets that were not asked for. The first five are crashes, the last two
 * power faults. `poweron` and `software` are someone unplugging the board or
 * pressing reset — the ESP32 reports its reset button as `poweron` — or the
 * firmware restarting on purpose.
 */
export const UNPLANNED_RESETS = new Set([
  'panic', 'cpu_lockup', 'int_wdt', 'task_wdt', 'wdt', 'brownout', 'pwr_glitch',
]);

export const CRASH_RESETS = new Set(['panic', 'cpu_lockup', 'int_wdt', 'task_wdt', 'wdt']);

/** The columns copied out of a report. Null where the body said nothing usable. */
export interface ReportColumns {
  v: number | null;
  firmwareVersion: string | null;
  board: string | null;
  bootCount: number | null;
  resetReason: string | null;
  uptimeMs: number | null;
  memFree: number | null;
  memLargestBlock: number | null;
  memMinFreeEver: number | null;
  psram: boolean | null;
  wifiRssi: number | null;
  printerLink: string | null;
}

const INT32_MAX = 2_147_483_647;

/** Copies the known fields out, and names any that arrived with the wrong type. */
export function readReport(body: Record<string, unknown>): { columns: ReportColumns; malformed: string[] } {
  const malformed: string[] = [];

  const at = (path: string): unknown =>
    path.split('.').reduce<unknown>(
      (node, key) => (node && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined),
      body,
    );

  const int = (path: string, max = INT32_MAX): number | null => {
    const value = at(path);
    if (value === undefined || value === null) return null;
    if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= max) return value;
    malformed.push(path);
    return null;
  };
  const str = (path: string, maxLength: number): string | null => {
    const value = at(path);
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && value.length <= maxLength) return value;
    malformed.push(path);
    return null;
  };
  const bool = (path: string): boolean | null => {
    const value = at(path);
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value;
    malformed.push(path);
    return null;
  };

  return {
    columns: {
      v: int('v'),
      firmwareVersion: str('firmware.version', 64),
      board: str('firmware.board', 64),
      bootCount: int('boot.count'),
      // Unrecognised reasons are stored as they are; only the length is bounded.
      resetReason: str('boot.resetReason', 32),
      // Milliseconds since boot outgrow 32 bits after 24 days.
      uptimeMs: int('boot.uptimeMs', Number.MAX_SAFE_INTEGER),
      memFree: int('memory.free'),
      memLargestBlock: int('memory.largestBlock'),
      memMinFreeEver: int('memory.minFreeEver'),
      psram: bool('memory.psram'),
      wifiRssi: int('wifi.rssi'),
      printerLink: str('printer.link', 16),
    },
    malformed,
  };
}

/**
 * How many times the device has booted since its previous report.
 *
 * Usually 0. A new `boot.count` is a new boot, and a jump of more than one is a
 * crash loop that ran while reports could not get through. A count that went
 * backwards is a re-provisioned board, and an uptime that went backwards with
 * the same count is a boot whose counter failed to save — one boot either way.
 * A device's first report is its current boot.
 */
export function bootsSince(
  current: { bootCount: number | null; uptimeMs: number | null },
  previous: { bootCount: number | null; uptimeMs: number | null } | null,
): number {
  if (current.bootCount === null && current.uptimeMs === null) return 0;
  if (!previous) return 1;

  if (current.bootCount !== null && previous.bootCount !== null) {
    if (current.bootCount > previous.bootCount) return current.bootCount - previous.bootCount;
    if (current.bootCount < previous.bootCount) return 1;
  }
  const rewound =
    current.uptimeMs !== null && previous.uptimeMs !== null && current.uptimeMs < previous.uptimeMs;
  return rewound ? 1 : 0;
}
