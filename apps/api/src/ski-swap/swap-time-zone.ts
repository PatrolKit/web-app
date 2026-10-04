/**
 * A swap's time zone: where it happens, so its receipts say the time a seller
 * saw on the wall. The server runs on UTC, and a time formatted without a zone
 * came out four or five hours ahead in the Northeast.
 */
export const DEFAULT_SWAP_TIME_ZONE = 'America/New_York';

/** Whether `tz` is an IANA zone this runtime knows, such as "America/Denver". */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "Oct 4, 2026, 2:30 PM EDT": the time in the swap's zone, and which zone that is. */
export function swapTimeText(d: Date, timeZone: string): string {
  const text = d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: isTimeZone(timeZone) ? timeZone : DEFAULT_SWAP_TIME_ZONE,
    timeZoneName: 'short',
  });
  // Some ICU versions put a narrow no-break space before AM/PM, which a label
  // font may not have: a plain space prints everywhere.
  return text.replace(/[\u202f\u00a0]/g, ' ');
}
