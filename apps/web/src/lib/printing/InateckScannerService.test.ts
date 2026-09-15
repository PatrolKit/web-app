import { describe, expect, it } from 'vitest';
import {
  AUTH_FRAME,
  buildSetName,
  mintScannerName,
  SCANNER_FACTORY_NAME_PREFIX,
  SCANNER_NAME_MAX_BYTES,
  SCANNER_NAME_PREFIX,
  SCANNER_NAME_PREFIXES,
} from './InateckScannerService';

/**
 * The scanner's command format was read off the manufacturer's encoder
 * (`libinateck_scanner_cmd.dylib`), not out of a specification — so the only
 * grounds for believing this file are the frames that encoder produced. They are
 * the test vectors below, and they are also what `webprinter_esp32`'s
 * `scanner_cmd.h` reproduces, which makes them the contract between the two
 * implementations rather than a fixture of ours.
 *
 * None of this can prove a scanner accepts the frame. It proves we send the same
 * bytes the vendor's own library does.
 */

const hex = (b: Uint8Array) =>
  [...b].map((n) => n.toString(16).padStart(2, '0').toUpperCase()).join(' ');

describe('set_name frames', () => {
  // Emitted by inateck_scanner_cmd_set_name for each of these names.
  const vendor: Record<string, string> = {
    Tom: 'F3 05 7F 40 54 6F 6D E7',
    'PKScan-01': 'F3 0B 7F 40 50 4B 53 63 61 6E 2D 30 31 6B',
    A: 'F3 03 7F 40 41 F6',
    '': 'F3 02 7F 40 B4',
  };

  for (const [name, frame] of Object.entries(vendor)) {
    it(`matches the vendor encoder for "${name}"`, () => {
      expect(hex(buildSetName(name))).toBe(frame);
    });
  }

  it('carries opcode 0x40 behind the 0x7F marker', () => {
    const f = buildSetName('x');
    expect([f[0], f[2], f[3]]).toEqual([0xf3, 0x7f, 0x40]);
  });

  it('counts the length from the marker to the last name byte', () => {
    // The two header bytes the length covers, plus the name itself.
    expect(buildSetName(mintScannerName())[1]).toBe(SCANNER_NAME_MAX_BYTES + 2);
  });

  it('checksums the low byte of everything before it', () => {
    const f = buildSetName('a longer name');
    const sum = f.slice(0, -1).reduce((a, b) => a + b, 0) & 0xff;
    expect(f[f.length - 1]).toBe(sum);
  });
});

describe('the auth frame', () => {
  // Sent before anything else: commands that arrive without it are discarded
  // silently, which is a failure with no symptom.
  it('survived being carried across from the firmware header intact', () => {
    expect(AUTH_FRAME.length).toBe(294);
    expect(AUTH_FRAME[0]).toBe(0xf1);
  });

  it('checksums, which is what says it was not truncated in transit', () => {
    const sum = AUTH_FRAME.slice(0, -1).reduce((a, b) => a + b, 0) & 0xff;
    expect(AUTH_FRAME[AUTH_FRAME.length - 1]).toBe(sum);
  });
});

describe('minting a name', () => {
  it('spends the whole 20-byte budget, because that is the point', () => {
    const name = mintScannerName();
    expect(new TextEncoder().encode(name).length).toBe(SCANNER_NAME_MAX_BYTES);
  });

  it('is prefixed so the iOS picker sorts it above everything else', () => {
    // ScannerKit matches on an upper-cased "PKSCAN" prefix.
    expect(mintScannerName().toUpperCase().startsWith('PKSCAN')).toBe(true);
    expect(mintScannerName().startsWith(SCANNER_NAME_PREFIX)).toBe(true);
  });

  it('avoids the characters a person misreads off a console log', () => {
    const tail = Array.from({ length: 200 }, () => mintScannerName().slice(SCANNER_NAME_PREFIX.length)).join('');
    expect(tail).toMatch(/^[0-9a-hjkmnp-tv-z]+$/);
  });

  it('does not repeat, which is the only job it has', () => {
    const seen = new Set(Array.from({ length: 5000 }, mintScannerName));
    expect(seen.size).toBe(5000);
  });
});

describe('what the picker will show', () => {
  // The picker filters on these prefixes, so a name they do not match is a
  // scanner nobody can select — including, after a rename, one we just made.
  const matches = (name: string) => SCANNER_NAME_PREFIXES.some((p) => name.startsWith(p));

  it('shows a scanner we just named, which is what makes a failed save recoverable', () => {
    expect(matches(mintScannerName())).toBe(true);
  });

  it('shows one straight out of the box', () => {
    expect(matches(`${SCANNER_FACTORY_NAME_PREFIX}-1A2B`)).toBe(true);
  });

  it('hides everything else, which is the point of filtering at all', () => {
    for (const other of ['M110', 'Q192E28B1060137', 'AirPods', 'PKSCAN_lowercase-only']) {
      expect(matches(other)).toBe(false);
    }
  });

  it('hides the pre-minting convention, which now needs a factory reset', () => {
    expect(matches('PKScan-01')).toBe(false);
  });
});
