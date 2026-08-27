import { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';

/**
 * The shared vocabulary for saying whether a piece of hardware is working.
 *
 * A station and a bridge are watched from two different pages and answer two
 * different questions — "can this counter print" and "is this box alive" — but
 * they read the same signals and should not disagree about what those signals
 * mean. One offline threshold, one set of tones, one way of writing "twenty
 * seconds of silence".
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'unknown';

export const TEXT_TONE: Record<Tone, string> = {
  ok: 'text-green-400',
  warn: 'text-amber-400',
  bad: 'text-red-400',
  unknown: 'text-gray-500',
};

/** One rolled-up verdict: what to show, and what it means on hover. */
export interface HardwareStatus {
  icon: IconDefinition;
  label: string;
  tone: Tone;
  spin?: boolean;
  title?: string;
}

/**
 * A bridge heartbeats every 1–5 seconds, so 20 is four missed beats.
 *
 * Chosen against the moment that matters: a seller standing at the counter
 * watching "Printing…" while nothing comes out. A minute of grace was kinder to
 * flaky venue wifi, but it meant staff learned nothing for over a minute after
 * a bridge died. Four missed beats still rides out a dropped packet or two.
 */
export const OFFLINE_AFTER_MS = 20_000;

/**
 * The same rule for a bridge that is not bound to a station.
 *
 * It is not heartbeating: the firmware treats "no station" as a configuration
 * problem a human fixes and backs off to a thirty-second retry, so judging it
 * on four missed beats it was never going to send reports a working box as
 * offline half the time. Two missed retries, plus slack.
 */
export const OFFLINE_AFTER_UNBOUND_MS = 70_000;

/**
 * Re-renders on a timer, so a status computed from the clock keeps up with it.
 *
 * Every "offline" verdict here is `now - lastSeen`, evaluated during render —
 * and a component only renders when something changes. Polling the device list
 * is not enough: react-query hands back the identical object when a refetch is
 * deep-equal, so nothing re-renders, and a bridge that has gone silent is
 * precisely the case where the data stops changing. The status would freeze on
 * the last value the hardware managed to report, which is the one moment it
 * matters most that it does not.
 */
export function useClockTick(everyMs = 5_000): void {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
}

export function recentlySeen(iso: string | null, withinMs = OFFLINE_AFTER_MS): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < withinMs;
}

/**
 * How long it has been silent, for the tooltip — the label just says Offline.
 *
 * Seconds matter here: hardware is called offline after twenty of them, so most
 * of what this describes is under a minute.
 */
export function lastSeenTitle(iso: string | null): string {
  if (!iso) return 'This bridge has never checked in.';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `Last checked in ${plural(seconds, 'second')} ago.`;
  if (seconds < 3600) return `Last checked in ${plural(Math.round(seconds / 60), 'minute')} ago.`;
  return `Last checked in ${plural(Math.round(seconds / 3600), 'hour')} ago.`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Renders a rolled-up verdict. The icon carries the tone; the text carries the fix. */
export function StatusLine({ status, className = '' }: { status: HardwareStatus; className?: string }) {
  return (
    <span
      className={`flex items-center gap-1.5 ${TEXT_TONE[status.tone]} ${className}`}
      title={status.title}
    >
      <FontAwesomeIcon icon={status.icon} spin={status.spin} />
      {status.label}
    </span>
  );
}
