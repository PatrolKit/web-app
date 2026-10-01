import { describe, expect, it } from 'vitest';
import { decodeScanSegment, ScanDecoder } from './InateckScannerService';

/**
 * The browser's scan decoder, used only by the scanner test. The vectors are the
 * iPad's `ScanDecoderTests.swift`, which the firmware's decoder also follows: a
 * test that decoded differently from the bridge would pass a scanner the bridge
 * then misreads.
 */

const bytes = (s: string) => new TextEncoder().encode(s);

describe('ScanDecoder', () => {
  it('joins a scan split across notifications, and emits nothing before the terminator', () => {
    const d = new ScanDecoder();
    expect(d.ingest(bytes('aSS26-'))).toEqual([]);
    expect(d.ingest(bytes('L-00'))).toEqual([]);
    expect(d.ingest(bytes('01\r'))).toEqual([{ symbology: 'code128', payload: 'SS26-L-0001' }]);
  });

  it('splits two scans in one notification, and holds a trailing fragment', () => {
    const d = new ScanDecoder();
    expect(d.ingest(bytes('aFIRST\rAhttps://x.io/s/abc\raPART'))).toEqual([
      { symbology: 'code128', payload: 'FIRST' },
      { symbology: 'qr', payload: 'https://x.io/s/abc' },
    ]);
    expect(d.ingest(bytes('IAL\r'))).toEqual([{ symbology: 'code128', payload: 'PARTIAL' }]);
  });

  it('ignores stray terminators', () => {
    expect(new ScanDecoder().ingest(bytes('\r\r'))).toEqual([]);
  });

  it('discards a barcode that overruns the buffer whole, then reads the next', () => {
    const d = new ScanDecoder();
    expect(d.ingest(bytes(`a${'X'.repeat(600)}\raNEXT\r`))).toEqual([{ symbology: 'code128', payload: 'NEXT' }]);
  });
});

describe('decodeScanSegment', () => {
  it('strips each known id', () => {
    expect(decodeScanSegment('fTICKET123')).toEqual({ symbology: 'code39', payload: 'TICKET123' });
    expect(decodeScanSegment('aSS26-L-0001')).toEqual({ symbology: 'code128', payload: 'SS26-L-0001' });
    expect(decodeScanSegment('Ahttps://skiswap.patrolkit.io/s/abc')).toEqual({ symbology: 'qr', payload: 'https://skiswap.patrolkit.io/s/abc' });
  });

  it('reads lowercase a as Code-128 and uppercase A as QR', () => {
    expect(decodeScanSegment('aPAYLOAD')?.symbology).toBe('code128');
    expect(decodeScanSegment('APAYLOAD')?.symbology).toBe('qr');
  });

  it('keeps an unrecognized leading character rather than stripping it', () => {
    expect(decodeScanSegment('SS26-L-0001')).toEqual({ symbology: 'unknown', unknownId: 'S', payload: 'SS26-L-0001' });
  });

  it('trims surrounding whitespace, and gives nothing for an empty segment', () => {
    expect(decodeScanSegment('aSS26-L-0001\n')).toEqual({ symbology: 'code128', payload: 'SS26-L-0001' });
    expect(decodeScanSegment('')).toBeNull();
    expect(decodeScanSegment('   \n')).toBeNull();
  });
});
