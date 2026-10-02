/**
 * Code 39, for the scanner test's legacy-ticket step only.
 *
 * The organization's pre-printed legacy tickets carry a bare number in Code 39
 * (server Plan 15). Nothing of ours prints Code 39 — our tags are Code 128-B —
 * so this covers digits, which is all a ticket number is, and nothing more.
 *
 * Each character is nine elements, bar first, alternating bar and space; three
 * of them are wide. Wide is three modules, narrow one, and characters are
 * separated by one narrow space. `*` starts and stops every symbol.
 */
const PATTERNS: Record<string, string> = {
  // 1 = wide. The standard table.
  '0': '000110100',
  '1': '100100001',
  '2': '001100001',
  '3': '101100000',
  '4': '000110001',
  '5': '100110000',
  '6': '001110000',
  '7': '000100101',
  '8': '100100100',
  '9': '001100100',
  '*': '010010100',
};

const WIDE = 3;

/** The bar/space module run for `digits`, start and stop included. Dark is true. */
export function code39Modules(digits: string): boolean[] {
  if (!/^\d+$/.test(digits)) throw new Error('Only digits are encoded here: a legacy ticket is a bare number.');
  const out: boolean[] = [];
  [...`*${digits}*`].forEach((ch, i) => {
    if (i > 0) out.push(false); // the narrow gap between characters
    [...PATTERNS[ch]].forEach((w, e) => {
      const dark = e % 2 === 0;
      for (let n = 0; n < (w === '1' ? WIDE : 1); n++) out.push(dark);
    });
  });
  return out;
}
