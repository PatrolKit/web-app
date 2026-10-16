/**
 * A closed check run, as a spreadsheet (Plan 52 D13): one row per check, in
 * plain columns for whatever program the patrol writes checks with.
 *
 * Pure, and tested, because this file is printed onto real checks and posted to
 * real addresses. A column silently shifted by one is somebody's money in
 * somebody else's envelope.
 */

export interface CheckRow {
  payee: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  amountCents: number;
  /** What the check is for, e.g. "Fall Ski Swap payout: 6 items". */
  memo: string;
  /** When the run was closed and exported. */
  date: Date;
}

export const CHECK_CSV_HEADERS = ['Payee', 'Street', 'City', 'State', 'ZIP', 'Amount', 'Memo', 'Date'] as const;

export function checksToCsv(rows: CheckRow[]): string {
  const lines = [CHECK_CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(
      [
        cell(row.payee),
        cell(row.street),
        cell(row.city),
        cell(row.state),
        cell(row.zip),
        // Bare decimal, no currency symbol: this column is summed and mail-merged.
        (row.amountCents / 100).toFixed(2),
        cell(row.memo),
        cell(row.date.toISOString().slice(0, 10)),
      ].join(','),
    );
  }
  // A trailing newline, because a file without one loses its last row to some
  // importers and to `wc -l`.
  return lines.join('\r\n') + '\r\n';
}

/** A check's mailing address, frozen on its line as `destination` (Plan 52 D6). */
export interface CheckAddress { street: string | null; city: string | null; state: string | null; zip: string | null }

export function addressToDestination(a: CheckAddress): string {
  return JSON.stringify({ street: a.street, city: a.city, state: a.state, zip: a.zip });
}

export function destinationToAddress(destination: string | null): CheckAddress {
  try {
    const a = destination ? (JSON.parse(destination) as Partial<CheckAddress>) : {};
    return { street: a.street ?? null, city: a.city ?? null, state: a.state ?? null, zip: a.zip ?? null };
  } catch {
    return { street: destination, city: null, state: null, zip: null };
  }
}

/** "12 Main St, Stowe, VT 05672" */
export function addressText(a: CheckAddress): string | null {
  const cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.street, cityLine].filter(Boolean).join(', ') || null;
}

/**
 * A phone number as somebody about to dial it wants to read it.
 *
 * Stored E.164, printed `(802) 555-1212`. Applied once, in the service, so the
 * check screen and the file it exports show the same string — they were
 * showing `+15550198203` and `(555) 019-8203` side by side, which reads like
 * two different numbers.
 *
 * Not only cosmetic: a bare `+18025551212` is a formula to a spreadsheet, and
 * the apostrophe that would otherwise defuse it rides along into every mail
 * merge. Formatting removes the leading `+` and the problem with it.
 *
 * Anything that is not a US number is left exactly as stored — mangling an
 * international number to look tidy is worse than an apostrophe.
 */
export function phoneForHumans(phone: string | null): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

/**
 * One field, quoted and made safe.
 *
 * The leading apostrophe on `= + - @` is not paranoia: Excel and Sheets treat a
 * cell beginning with one as a formula, so a seller called "-Smith" becomes an
 * error value and a malicious one becomes a command. Names are user input, and
 * this file is opened in a spreadsheet by definition.
 */
function cell(value: string | null | undefined): string {
  const text = (value ?? '').replace(/[\r\n]+/g, ' ').trim();
  const safe = /^[=+\-@\t]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
