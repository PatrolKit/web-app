/**
 * What a `Range` header asks for, against a body of `size` bytes (RFC 9110
 * §14.1.2), for the one shape a bridge sends: a single byte range.
 *
 * - `whole`: send everything as a 200. No header, a header that does not parse,
 *   a unit other than bytes, or several ranges at once — which the RFC lets a
 *   server answer with the whole representation, and no client of ours sends.
 * - `part`: send `start`..`end` inclusive as a 206. An end past the last byte is
 *   clamped to it rather than refused.
 * - `unsatisfiable`: a 416 — the range starts at or past the end.
 */
export type ByteRange =
  | { kind: 'whole' }
  | { kind: 'part'; start: number; end: number }
  | { kind: 'unsatisfiable' };

export function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (!header) return { kind: 'whole' };
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match) return { kind: 'whole' };
  const [, first, last] = match;

  // `bytes=-N`: the last N bytes.
  if (first === '') {
    if (last === '') return { kind: 'whole' };
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'part', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(first);
  const end = last === '' ? size - 1 : Number(last);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: 'whole' };
  // A range written back to front is invalid, and invalid is ignored. Only a
  // written end counts: an open one is measured from the body's last byte, so
  // `bytes=99999-` on a smaller body is past the end, not back to front.
  if (last !== '' && end < start) return { kind: 'whole' };
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'part', start, end: Math.min(end, size - 1) };
}
