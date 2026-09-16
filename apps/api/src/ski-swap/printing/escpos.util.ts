import { RASTER_FEED_BOTTOM, RASTER_FEED_TOP } from './geometry';

/**
 * ESC/POS command builders. Pure functions over a 1-bit raster; moved from the
 * browser unchanged so the bytes on the wire are identical whichever path
 * produced them.
 *
 * The head width is taken from the raster rather than a constant. It was a
 * module import, which meant a 62 mm job would have gone out declaring itself
 * 50 mm wide in the `GS v 0` header — and the raster already knows how wide it
 * is, so there was never anything for a second source to add.
 */

export function initialize(): Uint8Array {
  return new Uint8Array([0x1b, 0x40]);
}

export function setPrintEnergy(level = 2): Uint8Array {
  return new Uint8Array([0x1f, 0x11, 0x08, Math.min(level, 2)]);
}

export function setPrintSpeed(level = 3): Uint8Array {
  return new Uint8Array([0x1f, 0x11, 0x07, level]);
}

export function feed(dots = 30): Uint8Array {
  return new Uint8Array([0x1b, 0x4a, dots]);
}

/** GS v 0 — raster bit image, one bit per dot, padded to the head width. */
export function printRasterImage(rows: boolean[][]): Uint8Array {
  const widthDots = rows[0]?.length ?? 0;
  const widthBytes = Math.ceil(widthDots / 8);
  const totalH = rows.length + RASTER_FEED_TOP + RASTER_FEED_BOTTOM;
  const blank = new Uint8Array(widthBytes);
  const buf: number[] = [
    0x1d, 0x76, 0x30, 0x00,
    widthBytes & 0xff, widthBytes >> 8,
    totalH & 0xff, totalH >> 8,
  ];
  for (let i = 0; i < RASTER_FEED_TOP; i++) buf.push(...blank);
  for (const row of rows) {
    const headRow = new Uint8Array(widthBytes);
    for (let c = 0; c < widthDots; c++) {
      if (row[c]) headRow[c >> 3] |= 0x80 >> (c % 8);
    }
    buf.push(...headRow);
  }
  for (let i = 0; i < RASTER_FEED_BOTTOM; i++) buf.push(...blank);
  return new Uint8Array(buf);
}

/** A complete print job: reset, energy, speed, raster, feed. */
export function buildPrintJob(rows: boolean[][]): Uint8Array {
  const parts = [initialize(), setPrintEnergy(), setPrintSpeed(), printRasterImage(rows), feed()];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
