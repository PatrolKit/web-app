import type { TelemetryRange } from '../../../lib/api.types';

export const RANGES: { value: TelemetryRange; label: string }[] = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

/** Bytes as KB: memory on these boards is tens of kilobytes, never megabytes. */
export function kb(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** A duration a person reads at a glance: "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** How long ago, for "last seen". */
export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  return `${duration(Math.max(0, Date.now() - new Date(iso).getTime()))} ago`;
}

/** Plain words for the ESP32's reset reasons; anything else is shown as sent. */
export const RESET_REASONS: Record<string, string> = {
  poweron: 'Power on or reset button',
  external: 'External reset',
  software: 'Firmware restart',
  panic: 'Crash (panic)',
  int_wdt: 'Crash (interrupt watchdog)',
  task_wdt: 'Crash (task watchdog)',
  wdt: 'Crash (watchdog)',
  cpu_lockup: 'Crash (CPU lockup)',
  brownout: 'Power fault (brownout)',
  pwr_glitch: 'Power fault (glitch)',
  deepsleep: 'Woke from deep sleep',
  unknown: 'Unknown',
};

export function resetReason(reason: string | null): string {
  if (!reason) return 'Not reported';
  return RESET_REASONS[reason] ?? reason;
}
