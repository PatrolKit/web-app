/**
 * Debian version comparison, per Policy §5.6.12.
 *
 * Needed because the device diffs versions as *strings* and treats any
 * difference as work to do, so this server has to be the one that knows
 * `1.10.0` is newer than `1.9.0` — a `sort()` says otherwise, and would pin a
 * fleet backwards the first time a minor version reached double digits.
 *
 * Ported rather than invented. The three rules that are easy to get wrong:
 *
 *   - `~` sorts before *everything*, including the end of the string, which is
 *     what makes `1.0~rc1` older than `1.0`.
 *   - letters sort before every other non-digit character, so `1.0a` < `1.0+b`.
 *   - digit runs compare numerically with leading zeros ignored, so
 *     `1.007` == `1.7`.
 */

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

/**
 * The modified character order dpkg uses.
 *
 * The end of the string and a digit both order as 0, which is what lets the
 * non-digit loop below run off the end of either side without a bounds check.
 */
function order(c: string | undefined): number {
  if (c === undefined) return 0;
  if (isDigit(c)) return 0;
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return c.charCodeAt(0);
  if (c === '~') return -1;
  return c.charCodeAt(0) + 256;
}

/** Compares one upstream version or one revision. */
function compareFragment(a: string, b: string): number {
  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    // Non-digit run, character by character in the modified order.
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const diff = order(a[i]) - order(b[j]);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      i++;
      j++;
    }

    // Digit run, numerically. Leading zeros carry no value.
    while (a[i] === '0') i++;
    while (b[j] === '0') j++;

    // The first differing digit decides, but only once both runs end together:
    // a longer run of digits is the larger number regardless of what it starts
    // with, which is why the answer is held rather than returned here.
    let firstDiff = 0;
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (firstDiff === 0) firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
      i++;
      j++;
    }
    if (isDigit(a[i])) return 1;
    if (isDigit(b[j])) return -1;
    if (firstDiff !== 0) return firstDiff < 0 ? -1 : 1;
  }

  return 0;
}

interface ParsedVersion {
  epoch: number;
  upstream: string;
  revision: string;
}

/** `1:1.2.3-2` → `{epoch: 1, upstream: '1.2.3', revision: '2'}`. */
export function parseDebianVersion(version: string): ParsedVersion {
  const trimmed = version.trim();

  const colon = trimmed.indexOf(':');
  let epoch = 0;
  let rest = trimmed;
  if (colon !== -1 && /^\d+$/.test(trimmed.slice(0, colon))) {
    epoch = Number(trimmed.slice(0, colon));
    rest = trimmed.slice(colon + 1);
  }

  // The *last* hyphen, not the first: an upstream version may contain hyphens
  // and the revision may not.
  const hyphen = rest.lastIndexOf('-');
  if (hyphen === -1) return { epoch, upstream: rest, revision: '' };
  return { epoch, upstream: rest.slice(0, hyphen), revision: rest.slice(hyphen + 1) };
}

/** Negative if `a` is older, positive if newer, zero if they are equal. */
export function compareDebianVersions(a: string, b: string): number {
  const va = parseDebianVersion(a);
  const vb = parseDebianVersion(b);

  if (va.epoch !== vb.epoch) return va.epoch < vb.epoch ? -1 : 1;

  const upstream = compareFragment(va.upstream, vb.upstream);
  if (upstream !== 0) return upstream;

  return compareFragment(va.revision, vb.revision);
}

/** The newest of a set, or null if the set is empty. */
export function newestVersion(versions: readonly string[]): string | null {
  return versions.reduce<string | null>(
    (best, v) => (best === null || compareDebianVersions(v, best) > 0 ? v : best),
    null,
  );
}
