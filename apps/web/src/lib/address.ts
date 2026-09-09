/**
 * Reading a US address the way somebody actually types one.
 *
 * These are for the fields a person fills in on a phone, at a counter, with a
 * line behind them. So they coerce rather than complain: a state comes back as
 * a code whether it was typed, abbreviated, or autofilled by the browser as a
 * full name, and a ZIP loses whatever punctuation came with it.
 *
 * Addresses here are US only — the swap mails checks and Square is a US
 * account. A seller from elsewhere is a problem this app does not have yet, and
 * a "country" field nobody changes would be worse than the honest limit.
 */

/**
 * Everywhere USPS delivers to, by the code that goes on the envelope.
 *
 * Territories and the three military codes are in deliberately. They are rare,
 * and a form that refuses one refuses somebody who has no other answer to give.
 */
export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia',
  AS: 'American Samoa', GU: 'Guam', MP: 'Northern Mariana Islands',
  PR: 'Puerto Rico', VI: 'Virgin Islands',
  FM: 'Micronesia', MH: 'Marshall Islands', PW: 'Palau',
  AA: 'Armed Forces Americas', AE: 'Armed Forces Europe', AP: 'Armed Forces Pacific',
};

const BY_NAME = new Map(
  Object.entries(US_STATES).map(([code, name]) => [name.toUpperCase(), code]),
);

/**
 * What to show while a state is being typed: letters and spaces, upper-cased.
 *
 * Not truncated to two characters, which is the obvious thing and the wrong
 * one. `autoComplete="address-level1"` fills a full name on some platforms and
 * a code on others, and a hard two-character limit silently turns an
 * autofilled "Vermont" into "VE" — a wrong address that looks deliberate.
 * `resolveState` sorts the long form out afterwards.
 */
export function typeState(raw: string): string {
  return raw.replace(/[^A-Za-z ]/g, '').toUpperCase();
}

/**
 * The code to store, from whatever was typed. Empty string when it is not a
 * place — the caller decides whether that is "not finished yet" or "wrong".
 */
export function resolveState(raw: string): string {
  const v = raw.trim().replace(/\s+/g, ' ').toUpperCase();
  if (v in US_STATES) return v;
  return BY_NAME.get(v) ?? '';
}

/**
 * What to show while a ZIP is being typed: five digits, nothing else.
 *
 * A pasted or autofilled ZIP+4 loses its last four rather than being refused —
 * the extra digits route mail within a building and nothing here needs them.
 */
export function typeZip(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 5);
}

export function isZipComplete(zip: string): boolean {
  return /^\d{5}$/.test(zip);
}
