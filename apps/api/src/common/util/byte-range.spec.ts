import { parseByteRange } from './byte-range';

/** A 62 × 100 raster on an M221, which is what a bridge asks for in pieces. */
const SIZE = 56_448;

describe('parseByteRange', () => {
  it('answers the whole body when nothing is asked for', () => {
    expect(parseByteRange(undefined, SIZE)).toEqual({ kind: 'whole' });
    expect(parseByteRange('', SIZE)).toEqual({ kind: 'whole' });
  });

  it('takes one range, inclusive at both ends', () => {
    expect(parseByteRange('bytes=8192-12287', SIZE)).toEqual({ kind: 'part', start: 8192, end: 12287 });
    expect(parseByteRange('bytes=0-0', SIZE)).toEqual({ kind: 'part', start: 0, end: 0 });
  });

  it('clamps an end past the last byte rather than refusing it', () => {
    expect(parseByteRange('bytes=53248-57343', SIZE)).toEqual({ kind: 'part', start: 53248, end: SIZE - 1 });
  });

  it('reads an open end as "to the last byte", and a suffix as "the last N"', () => {
    expect(parseByteRange('bytes=56000-', SIZE)).toEqual({ kind: 'part', start: 56000, end: SIZE - 1 });
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({ kind: 'part', start: SIZE - 100, end: SIZE - 1 });
    expect(parseByteRange('bytes=-99999', SIZE)).toEqual({ kind: 'part', start: 0, end: SIZE - 1 });
  });

  it('is unsatisfiable when the start is at or past the end', () => {
    expect(parseByteRange(`bytes=${SIZE}-${SIZE + 10}`, SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=99999-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores what it does not take, and answers the whole body', () => {
    for (const header of ['bytes=0-99,200-299', 'items=0-9', 'bytes=500-100', 'bytes=60000-100', 'bytes=abc', 'bytes=-']) {
      expect({ header, range: parseByteRange(header, SIZE) }).toEqual({ header, range: { kind: 'whole' } });
    }
  });
});
