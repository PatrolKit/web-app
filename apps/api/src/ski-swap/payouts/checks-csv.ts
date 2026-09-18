/**
 * The check register, as a spreadsheet (Plan 25 §10).
 *
 * Pure, and tested, because this file is printed onto real checks and posted to
 * real addresses. A column silently shifted by one is somebody's money in
 * somebody else's envelope.
 */

export interface CheckRow {
  sellerName: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** Already formatted for reading. See `phoneForHumans`. */
  phone: string | null;
  amountCents: number;
  /** The payout line id: what to write in the memo, and what to search on later. */
  reference: string;
  checkNumber: string | null;
  sentAt: Date | null;
}

export const CHECK_CSV_HEADERS = [
  'Name', 'Street', 'City', 'State', 'ZIP', 'Phone',
  'Amount', 'Reference', 'Check number', 'Sent',
] as const;

export function checksToCsv(rows: CheckRow[]): string {
  const lines = [CHECK_CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(
      [
        cell(row.sellerName),
        cell(row.street),
        cell(row.city),
        cell(row.state),
        cell(row.zip),
        cell(row.phone),
        // Bare decimal, no currency symbol: this column is summed and mail-merged.
        (row.amountCents / 100).toFixed(2),
        cell(row.reference),
        cell(row.checkNumber),
        cell(row.sentAt ? row.sentAt.toISOString().slice(0, 10) : ''),
      ].join(','),
    );
  }
  // A trailing newline, because a file without one loses its last row to some
  // importers and to `wc -l`.
  return lines.join('\r\n') + '\r\n';
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
