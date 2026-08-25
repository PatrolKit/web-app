/**
 * Sweep-time arithmetic, mirrored by `AutoClockOutService` on iOS (§5.6).
 *
 * Devices, not the server, originate auto clock-outs. The server needs the same maths
 * only to answer "which open shifts should a device already have closed?" for the
 * admin "still open" view.
 */

/** Offset in ms between UTC and the zone's local wall time at that instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(instant).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  // 'hour' can come back as '24' at midnight in some ICU versions.
  const hour = Number(parts['hour']) % 24;
  const asUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    hour,
    Number(parts['minute']),
    Number(parts['second']),
  );
  return asUtc - instant.getTime();
}

/** The instant at which the given local wall time occurs in the zone. */
function instantForLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two passes settle the offset even across a DST boundary.
  let instant = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  instant = new Date(naive - zoneOffsetMs(instant, timeZone));
  return instant;
}

function localParts(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(instant).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return { year: Number(parts['year']), month: Number(parts['month']), day: Number(parts['day']) };
}

/**
 * The nearest `HH:mm` in `timeZone` that FOLLOWS `clockInAt` (§5.6). "Following" is
 * load-bearing: the nearest 03:00 in absolute terms to an 08:00 clock-in is that same
 * morning's, five hours before the shift started.
 */
export function sweepAt(clockInAt: Date, timeZone: string, autoCloseLocalTime: string): Date {
  const [hh, mm] = autoCloseLocalTime.split(':').map(Number);
  const { year, month, day } = localParts(clockInAt, timeZone);
  for (let offset = 0; offset <= 2; offset++) {
    const candidate = instantForLocal(year, month, day + offset, hh ?? 3, mm ?? 0, timeZone);
    if (candidate.getTime() > clockInAt.getTime()) return candidate;
  }
  // Unreachable for sane inputs; fall back to 24h out rather than throwing.
  return new Date(clockInAt.getTime() + 24 * 3600_000);
}

/** What an auto clock-out would record for this shift: min(clockIn + Nh, sweepAt). */
export function autoClockOutAt(
  clockInAt: Date,
  timeZone: string,
  autoCloseLocalTime: string,
  autoCloseAfterHours: number,
): Date {
  const sweep = sweepAt(clockInAt, timeZone, autoCloseLocalTime);
  const byDuration = new Date(clockInAt.getTime() + autoCloseAfterHours * 3600_000);
  return byDuration.getTime() < sweep.getTime() ? byDuration : sweep;
}

/** Deterministic id so a device and any other device produce the same row (§5.6). */
export function autoEventId(clockInEventId: string): string {
  return `auto:${clockInEventId}`;
}
