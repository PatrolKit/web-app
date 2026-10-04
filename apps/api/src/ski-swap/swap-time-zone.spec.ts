import { CreateSwapSchema, PatchSwapSchema } from '../contracts/ski-swap.contracts';
import { DEFAULT_SWAP_TIME_ZONE, isTimeZone, swapTimeText } from './swap-time-zone';

/** A swap's time zone: receipt times are given where the swap happens, not on the server's UTC. */
describe('a swap’s time zone', () => {
  const noon = new Date('2026-12-05T17:00:00Z');

  it('gives a time in the zone, with its name', () => {
    expect(swapTimeText(noon, 'America/New_York')).toBe('Dec 5, 2026, 12:00 PM EST');
    expect(swapTimeText(noon, 'America/Los_Angeles')).toBe('Dec 5, 2026, 9:00 AM PST');
  });

  it('falls back to the default for a zone it doesn’t know, rather than failing a receipt', () => {
    expect(swapTimeText(noon, 'Mars/Olympus')).toBe(swapTimeText(noon, DEFAULT_SWAP_TIME_ZONE));
  });

  it('knows a zone when it sees one', () => {
    expect(isTimeZone('America/Denver')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });

  it('is accepted on create and patch only when it’s a real zone', () => {
    expect(PatchSwapSchema.safeParse({ timeZone: 'America/Denver' }).success).toBe(true);
    expect(PatchSwapSchema.safeParse({ timeZone: 'Mars/Olympus' }).success).toBe(false);
    expect(CreateSwapSchema.safeParse({ title: 'Fall Swap', locationId: 'L1', timeZone: 'Eastern' }).success).toBe(false);
    expect(CreateSwapSchema.safeParse({ title: 'Fall Swap', locationId: 'L1' }).success).toBe(true);
  });
});
