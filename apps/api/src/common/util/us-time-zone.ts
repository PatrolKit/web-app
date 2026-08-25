/**
 * Resolves a US postal address to an IANA time zone, offline.
 *
 * Resorts carry a time zone because sweep/auto-close arithmetic depends on it
 * (see `sweepAt`), but admins shouldn't have to know IANA names. ZIP wins when
 * we recognise it; otherwise the state's dominant zone is the answer.
 *
 * Split states are handled by ZIP below. The table is good, not perfect — a
 * handful of county-line ZIPs in IN, KS, ND, and SD resolve to their state's
 * dominant zone — so the resort form always lets an admin override the result.
 */

export const DEFAULT_TIME_ZONE = 'America/New_York';

/** Every zone this resolver can return, for the override picker. */
export const US_TIME_ZONES = [
  'America/New_York',
  'America/Detroit',
  'America/Indiana/Indianapolis',
  'America/Chicago',
  'America/Denver',
  'America/Boise',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Adak',
  'Pacific/Honolulu',
  'America/Puerto_Rico',
] as const;

const STATE_ZONES: Record<string, string> = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix',
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DE: 'America/New_York',
  DC: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  ID: 'America/Boise',
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',
  KS: 'America/Chicago',
  KY: 'America/New_York',
  LA: 'America/Chicago',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/Detroit',
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  MT: 'America/Denver',
  NE: 'America/Chicago',
  NV: 'America/Los_Angeles',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NY: 'America/New_York',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  UT: 'America/Denver',
  VT: 'America/New_York',
  VA: 'America/New_York',
  WA: 'America/Los_Angeles',
  WV: 'America/New_York',
  WI: 'America/Chicago',
  WY: 'America/Denver',
  PR: 'America/Puerto_Rico',
  VI: 'America/Puerto_Rico',
};

/** Inclusive 5-digit ZIP ranges, checked in order. Only split states need entries. */
const ZIP_RANGES: Array<{ from: number; to: number; zone: string }> = [
  // ── Florida: the western panhandle is Central ──────────────────────────────
  { from: 32400, to: 32599, zone: 'America/Chicago' },

  // ── Kentucky: Eastern down to 42000, Central through the Purchase ─────────
  { from: 42000, to: 42499, zone: 'America/Chicago' },

  // ── Indiana: Chicagoland corner and the Evansville corner are Central ──────
  { from: 46300, to: 46411, zone: 'America/Chicago' },
  { from: 47601, to: 47670, zone: 'America/Chicago' },
  { from: 47701, to: 47750, zone: 'America/Chicago' },

  // ── Tennessee: Chattanooga east through the Tri-Cities is Eastern ─────────
  { from: 37400, to: 37999, zone: 'America/New_York' },

  // ── North Dakota: the southwest corner is Mountain ────────────────────────
  { from: 58601, to: 58656, zone: 'America/Denver' },

  // ── South Dakota: west river is Mountain ──────────────────────────────────
  { from: 57701, to: 57799, zone: 'America/Denver' },
  { from: 57620, to: 57648, zone: 'America/Denver' },

  // ── Nebraska: the panhandle is Mountain ───────────────────────────────────
  { from: 69101, to: 69367, zone: 'America/Denver' },

  // ── Kansas: the four far-western counties are Mountain ────────────────────
  { from: 67735, to: 67735, zone: 'America/Denver' },
  { from: 67741, to: 67741, zone: 'America/Denver' },
  { from: 67748, to: 67748, zone: 'America/Denver' },
  { from: 67758, to: 67758, zone: 'America/Denver' },
  { from: 67857, to: 67857, zone: 'America/Denver' },
  { from: 67862, to: 67862, zone: 'America/Denver' },
  { from: 67878, to: 67879, zone: 'America/Denver' },

  // ── Texas: El Paso County is Mountain (Hudspeth's ZIPs are in ZIP_EXACT) ──
  { from: 79900, to: 79999, zone: 'America/Denver' },

  // ── Oregon: most of Malheur County is Mountain ────────────────────────────
  { from: 97901, to: 97920, zone: 'America/Denver' },

  // ── Idaho: the panhandle and the Lewiston corner are Pacific ──────────────
  { from: 83501, to: 83555, zone: 'America/Los_Angeles' },
  { from: 83801, to: 83876, zone: 'America/Los_Angeles' },

  // ── Nevada: West Wendover keeps Utah's clock ──────────────────────────────
  { from: 89883, to: 89883, zone: 'America/Denver' },

  // ── Arizona: the Navajo Nation observes DST, the rest of the state doesn't ─
  { from: 86502, to: 86556, zone: 'America/Denver' },
  { from: 86033, to: 86033, zone: 'America/Denver' },
  { from: 86044, to: 86044, zone: 'America/Denver' },
  { from: 86053, to: 86054, zone: 'America/Denver' },

  // ── Alaska: the far-western Aleutians run an hour behind Anchorage ─────────
  { from: 99546, to: 99547, zone: 'America/Adak' },
  { from: 99591, to: 99591, zone: 'America/Adak' },
  { from: 99638, to: 99638, zone: 'America/Adak' },
];

/**
 * Counties whose ZIPs interleave with their neighbours', so a range would sweep
 * up the wrong side of the line.
 */
const ZIP_EXACT: Record<number, string> = Object.fromEntries([
  // Michigan's four Wisconsin-border UP counties (Dickinson, Menominee, Iron,
  // Gogebic) run on Central; the rest of the UP, Keweenaw included, does not.
  ...[
    49801, 49802, 49812, 49815, 49821, 49831, 49847, 49852, 49858, 49863, 49870,
    49874, 49876, 49881, 49887, 49892, 49893, 49896, 49902, 49903, 49911, 49915,
    49920, 49927, 49935, 49938, 49947, 49969,
  ].map((z) => [z, 'America/Chicago']),

  // El Paso and Hudspeth counties are Mountain; their 798xx neighbours in the
  // Big Bend (Alpine, Marfa, Van Horn) are Central, so ranges don't work here.
  ...[79821, 79835, 79836, 79838, 79839, 79849, 79853, 79837, 79847, 79848].map(
    (z) => [z, 'America/Denver'],
  ),
]);

/**
 * Best-effort IANA zone for a US address. Returns null when there's nothing to
 * go on (no ZIP, unrecognised state) so callers can keep whatever they had.
 */
export function timeZoneForAddress(addr: {
  state?: string | null;
  zip?: string | null;
}): string | null {
  const zip = Number((addr.zip ?? '').trim().slice(0, 5));
  if (Number.isInteger(zip) && zip > 0) {
    if (zip in ZIP_EXACT) return ZIP_EXACT[zip];
    const hit = ZIP_RANGES.find((r) => zip >= r.from && zip <= r.to);
    if (hit) return hit.zone;
  }

  const state = (addr.state ?? '').trim().toUpperCase();
  return STATE_ZONES[state] ?? null;
}

/** A bad IANA name would silently break sweep arithmetic, so reject it at the door. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
