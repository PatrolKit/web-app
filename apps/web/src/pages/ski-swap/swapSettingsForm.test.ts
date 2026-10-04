import { describe, expect, it } from 'vitest';
import type { SwapResponse } from '../../lib/api.types';
import {
  browserTimeZone, changes, finePrintText, formFor, otherTimeZones, receiptLinkOptions, receiptSettingsProblem,
  ticketSettingsProblem, US_TIME_ZONES,
} from './swapSettingsForm';

const swap = {
  id: 'swap-1', title: 'Ski Swap 2026', locationId: 'loc', slug: 'ss26', timeZone: 'America/New_York', allowLegacyCheckin: false,
  allowPrintCheckin: true, allowLegacyWeb: false, allowPrintWeb: true, printLegacyHelperLabels: false, labelsPerItem: 1,
  skuLookupEnabled: false, sellerLookupEnabled: false, sellerLoginEnabled: false,
  receiptMode: 'ITEMIZED', receiptShowSku: true, receiptShowName: true, receiptShowPrice: true, receiptLink: 'NONE',
  receiptPrintEnabled: true, receiptPaperSize: '62x100', receiptFinePrintEnabled: false, receiptFinePrint: null,
} as SwapResponse;

describe('the settings dialog’s one save', () => {
  it('sends nothing that wasn’t changed', () => {
    expect(changes(formFor(swap), swap)).toEqual({});
  });

  it('sends only what changed, across tabs', () => {
    const form = { ...formFor(swap), slug: 'spring', skuLookupEnabled: true, labelsPerItem: 2 };
    expect(changes(form, swap)).toEqual({ slug: 'spring', skuLookupEnabled: true, labelsPerItem: 2 });
  });

  it('starts a new swap with every status switch off', () => {
    expect(formFor(null)).toMatchObject({ skuLookupEnabled: false, sellerLookupEnabled: false, sellerLoginEnabled: false });
  });
});

describe('the ticket settings (Plan 34)', () => {
  it('start a new swap on print tickets in both places, and no legacy tickets', () => {
    expect(formFor(null)).toMatchObject({ allowLegacyCheckin: false, allowLegacyWeb: false, allowPrintCheckin: true, allowPrintWeb: true });
  });

  it('need a way in at each place', () => {
    const form = formFor(swap);
    expect(ticketSettingsProblem(form)).toBeNull();
    expect(ticketSettingsProblem({ ...form, allowPrintCheckin: false })).toMatch(/Staff check-in needs/);
    expect(ticketSettingsProblem({ ...form, allowPrintWeb: false })).toMatch(/The web needs/);
    expect(ticketSettingsProblem({ ...form, allowPrintCheckin: false, allowLegacyCheckin: true })).toBeNull();
  });
});

describe('the receipt settings (Plan 36)', () => {
  it('start a new swap itemized, with every column, no link, printing on 62 × 100, and no fine print', () => {
    expect(formFor(null)).toMatchObject({
      receiptMode: 'ITEMIZED', receiptShowSku: true, receiptShowName: true, receiptShowPrice: true,
      receiptLink: 'NONE', receiptPrintEnabled: true, receiptPaperSize: '62x100',
      receiptFinePrintEnabled: false, receiptFinePrint: null,
    });
  });

  it('save only what changed', () => {
    const form = { ...formFor(swap), receiptShowPrice: false, receiptPaperSize: '50x30' as const };
    expect(changes(form, swap)).toEqual({ receiptShowPrice: false, receiptPaperSize: '50x30' });
  });

  it('offer the status pages switched on in the dialog', () => {
    expect(receiptLinkOptions(formFor(swap))).toEqual([]);
    expect(receiptLinkOptions({ ...formFor(swap), skuLookupEnabled: true, sellerLoginEnabled: true }).map((o) => o.value))
      .toEqual(['SKU_LOOKUP', 'SELLER_LOGIN']);
  });

  it('refuse what the server would', () => {
    const form = formFor(swap);
    expect(receiptSettingsProblem(form)).toBeNull();
    expect(receiptSettingsProblem({ ...form, receiptMode: 'STATUS_ONLY' })).toMatch(/needs a status page/);
    expect(receiptSettingsProblem({ ...form, receiptShowSku: false, receiptShowName: false })).toMatch(/SKU or description/);
    expect(receiptSettingsProblem({ ...form, receiptFinePrintEnabled: true, receiptFinePrint: '<p></p>' })).toMatch(/Add some fine print/);
    expect(receiptSettingsProblem({ ...form, receiptFinePrintEnabled: true, receiptFinePrint: `<p>${'x'.repeat(2001)}</p>` }))
      .toMatch(/2,000/);
    expect(receiptSettingsProblem({ ...form, receiptFinePrintEnabled: true, receiptFinePrint: '<p>Final sale.</p>' })).toBeNull();
    // No receipt: nothing else is judged.
    expect(receiptSettingsProblem({ ...form, receiptMode: 'NONE', receiptFinePrintEnabled: true, receiptFinePrint: null })).toBeNull();
  });

  it('count fine print by its text, not its markup', () => {
    expect(finePrintText('<p><strong>All</strong> sales&nbsp;final.</p><ul><li><p>No refunds</p></li></ul>'))
      .toBe('All sales final.No refunds');
  });
});

describe('the time zone', () => {
  it('starts a new swap where the browser is, and keeps a saved one', () => {
    expect(formFor(null).timeZone).toBe(browserTimeZone());
    expect(formFor({ ...swap, timeZone: 'America/Denver' }).timeZone).toBe('America/Denver');
  });

  it('saves only when changed', () => {
    expect(changes({ ...formFor(swap), timeZone: 'America/Chicago' }, swap)).toEqual({ timeZone: 'America/Chicago' });
  });

  it('lists the US zones once, first', () => {
    const others = otherTimeZones();
    expect(US_TIME_ZONES.some((z) => others.includes(z.value))).toBe(false);
    expect(others).toContain('Europe/Zurich');
  });
});
