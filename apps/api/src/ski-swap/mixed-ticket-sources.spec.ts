import { SwapService } from './swap.service';
import { LegacyTicketService } from './legacy-ticket.service';
import { SellerSelfService } from './seller-self.service';
import { PrinterService } from './printer.service';

/**
 * Printed labels beside legacy tickets (Plan 31).
 *
 * "Legacy tickets only" is now two settings, staff check-in's and the web's. A
 * business seller may hold issued tickets and a printer at once. An upload can
 * generate SKUs for rows without a ticket, and a seller's hand entry can leave
 * the ticket blank, unless the swap's web takes tickets only.
 */

// ─── How items come in, per place (Plan 34) ──────────────────────────────────

function swapHarness(start: Record<string, unknown> = {}) {
  const swap: Record<string, unknown> = {
    id: 'swap-1', orgId: 'org-1', title: 'Fall', squareCategoryId: 'cat', locationId: 'loc', active: false,
    skuPrefix: 'FAL', allowLegacyCheckin: false, allowLegacyWeb: false, allowPrintCheckin: true, allowPrintWeb: true,
    printLegacyHelperLabels: false, labelsPerItem: 1, createdAt: new Date(), updatedAt: new Date(), ...start,
  };
  const prisma = {
    skiSwap: {
      findFirst: async () => swap,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        const { activeSkuPrefix: _, ...rest } = data;
        Object.assign(swap, rest);
        return swap;
      },
    },
  };
  return { swaps: new SwapService(prisma as never, {} as never), swap };
}

describe('how items come in, at staff check-in and on the web', () => {
  it('starts on print tickets in both places, and no legacy tickets', async () => {
    const { swaps } = swapHarness();
    await expect(swaps.get('org-1', 'swap-1')).resolves.toMatchObject({
      allowLegacyCheckin: false, allowLegacyWeb: false, allowPrintCheckin: true, allowPrintWeb: true,
    });
  });

  it('sets each place on its own, and sends them all back', async () => {
    const { swaps } = swapHarness();
    await expect(swaps.patch('org-1', 'swap-1', { allowLegacyWeb: true, allowPrintWeb: false }))
      .resolves.toMatchObject({ allowLegacyWeb: true, allowPrintWeb: false, allowLegacyCheckin: false, allowPrintCheckin: true });
  });

  it('refuses leaving a place with no way in', async () => {
    const { swaps } = swapHarness();
    await expect(swaps.patch('org-1', 'swap-1', { allowPrintCheckin: false })).rejects.toThrow(/Staff check-in needs/);
    await expect(swaps.patch('org-1', 'swap-1', { allowPrintWeb: false })).rejects.toThrow(/The web needs/);
  });

  it('takes the switch in one change from print tickets to legacy tickets', async () => {
    const { swaps } = swapHarness();
    await expect(swaps.patch('org-1', 'swap-1', { allowLegacyCheckin: true, allowPrintCheckin: false }))
      .resolves.toMatchObject({ allowLegacyCheckin: true, allowPrintCheckin: false });
  });
});

// ─── Uploads ─────────────────────────────────────────────────────────────────

function tickets(opts: { ranges?: { startNumber: number; endNumber: number }[]; webTicketsOnly?: boolean; shops?: { id: string; businessName: string }[] } = {}) {
  const prisma = {
    legacyTicketRange: {
      findMany: async () => (opts.ranges ?? [{ startNumber: 67000, endNumber: 67099 }]).map((r) => ({
        ...r, sellerId: 'seller-1',
        seller: { businessName: 'Alpine Sports', membership: { user: { firstName: null, lastName: null, email: null, phone: null } } },
      })),
    },
    swapItem: { findMany: async () => [] },
    skiSwap: { findFirst: async () => ({ allowLegacyWeb: true, allowPrintWeb: !opts.webTicketsOnly }) },
    sellerProfile: {
      findMany: async () => (opts.shops ?? []).map((s) => ({
        ...s, membership: { user: { firstName: null, lastName: null, email: null, phone: null } },
      })),
    },
  };
  return new LegacyTicketService(prisma as never);
}

const row = (sku: string) => ({ sku, priceCents: 1000 });

describe('an upload, row by row', () => {
  it('needs a ticket on every row with the switch off', async () => {
    const results = await tickets().checkImportRows('swap-1', 'seller-1', [row('67001'), row('')],
      { generateSkus: false, webTicketsOnly: false });
    expect(results[0].outcome).toBe('ok');
    expect(results[1].error).toMatch(/Generate SKUs as needed/);
  });

  it('generates a SKU for a row without a ticket with the switch on, and still checks the ticket rows', async () => {
    const results = await tickets().checkImportRows('swap-1', 'seller-1', [row('67001'), row(''), row('68000')],
      { generateSkus: true, webTicketsOnly: false });
    expect(results.map((r) => [r.outcome, !!r.generated])).toEqual([['ok', false], ['ok', true], ['error', false]]);
  });

  it('refuses the switch outright when the web takes tickets only', async () => {
    await expect(tickets().checkImportRows('swap-1', 'seller-1', [row('')], { generateSkus: true, webTicketsOnly: true }))
      .rejects.toThrow(/legacy tickets only on the web/);
  });

  it('lets a seller with no tickets upload, with every row generated', async () => {
    const service = tickets({ ranges: [] });
    const ok = await service.checkImportRows('swap-1', 'seller-1', [row(''), row('')], { generateSkus: true, webTicketsOnly: false });
    expect(ok.every((r) => r.outcome === 'ok' && r.generated)).toBe(true);
    const withTicket = await service.checkImportRows('swap-1', 'seller-1', [row('67001')], { generateSkus: true, webTicketsOnly: false });
    expect(withTicket[0].error).toMatch(/no tickets for this swap/);
    await expect(service.checkImportRows('swap-1', 'seller-1', [row('')], { generateSkus: false, webTicketsOnly: false }))
      .rejects.toThrow(/Generate SKUs as needed/);
  });
});

describe('who staff may upload for', () => {
  it('adds every business seller when the web isn’t tickets-only', async () => {
    const sellers = await tickets({ shops: [{ id: 'seller-2', businessName: 'Beta Shop' }] }).sellersWithRanges('org-1', 'swap-1');
    expect(sellers.map((s) => [s.displayName, s.ranges.length])).toEqual([['Alpine Sports', 1], ['Beta Shop', 0]]);
  });

  it('keeps to ticket holders when it is', async () => {
    const sellers = await tickets({ webTicketsOnly: true, shops: [{ id: 'seller-2', businessName: 'Beta Shop' }] })
      .sellersWithRanges('org-1', 'swap-1');
    expect(sellers.map((s) => s.displayName)).toEqual(['Alpine Sports']);
  });
});

// ─── Hand entry ──────────────────────────────────────────────────────────────

function selfService(opts: { webTicketsOnly?: boolean; holdsTickets?: boolean }) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    sellerProfile: { findFirst: async () => ({ id: 'seller-1', businessName: 'Alpine Sports' }) },
    skiSwap: { findFirst: async () => ({ id: 'swap-1', allowLegacyWeb: true, allowPrintWeb: !opts.webTicketsOnly }) },
  };
  const ticketService = {
    isLegacySeller: async () => !!opts.holdsTickets,
    assertNotExhausted: async () => undefined,
    formState: async () => ({ suggested: 67001 }),
    assertUsable: async () => undefined,
  };
  const items = { createAtStation: async (_o: string, _s: string, data: Record<string, unknown>) => { created.push(data); return data; } };
  const unused = {} as never;
  const svc = new SellerSelfService(prisma as never, items as never, unused, unused, unused, ticketService as never);
  return { svc, created };
}

const ITEM = { swapId: 'swap-1', categoryId: 'cat-skis', priceCents: 2500, quantity: 1 };

describe('a seller entering an item by hand', () => {
  it('with tickets, takes the next one unless asked for a generated SKU', async () => {
    const { svc, created } = selfService({ holdsTickets: true });
    await svc.createItem('org-1', 'user-1', ITEM);
    await svc.createItem('org-1', 'user-1', { ...ITEM, generateSku: true });
    expect(created[0]).toMatchObject({ sku: '67001', alreadyPrinted: true });
    expect(created[1]).not.toHaveProperty('alreadyPrinted');
    expect(created[1].sku).toBeUndefined();
  });

  it('is refused a generated SKU when the web takes tickets only', async () => {
    const { svc } = selfService({ holdsTickets: true, webTicketsOnly: true });
    await expect(svc.createItem('org-1', 'user-1', { ...ITEM, generateSku: true })).rejects.toThrow(/legacy tickets only/);
  });

  it('can’t add anything without tickets when the web takes tickets only', async () => {
    const { svc, created } = selfService({ holdsTickets: false, webTicketsOnly: true });
    await expect(svc.createItem('org-1', 'user-1', ITEM)).rejects.toThrow(/Ask the organizer for a block of tickets/);
    expect(created).toHaveLength(0);
  });

  it('without tickets and with the web open, gets a generated SKU as before', async () => {
    const { svc, created } = selfService({ holdsTickets: false });
    await svc.createItem('org-1', 'user-1', ITEM);
    expect(created[0].sku).toBeUndefined();
  });
});

// ─── Both at once ────────────────────────────────────────────────────────────

describe('a seller with tickets and a printer', () => {
  it('can be issued a range while holding a printer', async () => {
    const prisma = {
      skiSwap: { findFirst: async () => ({ id: 'swap-1' }) },
      sellerProfile: { findFirst: async () => ({ id: 'seller-1' }) },
      legacyTicketRange: { findFirst: async () => null, create: async () => ({}), findMany: async () => [] },
      swapItem: { findMany: async () => [] },
      // No swapPrinter here: the old refusal looked one up, and would now throw.
    };
    await expect(new LegacyTicketService(prisma as never).addRange('org-1', 'swap-1', 'seller-1', { startNumber: 1, endNumber: 10 }))
      .resolves.toBeDefined();
  });

  it('can be given a printer while holding ranges', async () => {
    const printer = { id: 'printer-1', orgId: 'org-1', name: 'Shop printer', bluetoothName: 'Q1', model: 'm110', paperSize: '50x30',
      marginTop: 4, marginBottom: 4, marginLeft: 0, marginRight: 28, assignedSellerId: null, bridgeDeviceId: null, bridge: null, seller: null };
    const prisma = {
      swapPrinter: { findFirst: async () => printer, update: async ({ data }: { data: object }) => ({ ...printer, ...data }) },
      sellerProfile: { findFirst: async () => ({ id: 'seller-1' }) },
      // No legacyTicketRange here, for the same reason.
    };
    await expect(new PrinterService(prisma as never, {} as never).patch('org-1', 'printer-1', { assignedSellerId: 'seller-1' }))
      .resolves.toMatchObject({ assignedSellerId: 'seller-1' });
  });
});

describe('an upload to a swap that takes no tickets', () => {
  it('imports generated rows and refuses ticket rows', async () => {
    const results = await tickets({ ranges: [] }).checkImportRows('swap-1', 'seller-1', [row(''), row('67001')],
      { generateSkus: true, webTicketsOnly: false, acceptsTickets: false });
    expect(results[0]).toMatchObject({ outcome: 'ok', generated: true });
    expect(results[1].error).toMatch(/doesn’t take legacy tickets/);
  });
});

describe('which SKUs the web made', () => {
  it('is neither a ticket nor a station’s', async () => {
    const { isWebMadeSku } = await import('./item.service');
    expect(isWebMadeSku('MIX-0042')).toBe(true);
    expect(isWebMadeSku('71001')).toBe(false);
    expect(isWebMadeSku('SS26-A-0001')).toBe(false);
  });
});

// ─── Legacy tickets off on the web, on at check-in (Plan 34) ─────────────────

describe('a swap whose web takes no legacy tickets', () => {
  const ranges = [{ startNumber: 67000, endNumber: 67099 }];

  it('offers a shop no tickets on the web, whatever blocks it holds', async () => {
    const prisma = {
      legacyTicketRange: { findMany: async () => ranges },
      swapItem: { findMany: async () => [] },
      skiSwap: { findUnique: async () => ({ allowLegacyWeb: false, allowPrintWeb: true }) },
    };
    await expect(new LegacyTicketService(prisma as never).formState('swap-1', 'seller-1'))
      .resolves.toEqual({ ranges: [], suggested: null, exhausted: false, webTicketsOnly: false });
  });

  it('lists shops for staff upload without their blocks', async () => {
    const prisma = {
      legacyTicketRange: {
        findMany: async () => ranges.map((r) => ({
          ...r, sellerId: 'seller-1',
          seller: { businessName: 'Alpine Sports', membership: { user: { firstName: null, lastName: null, email: null, phone: null } } },
        })),
      },
      swapItem: { findMany: async () => [] },
      skiSwap: { findFirst: async () => ({ allowLegacyWeb: false, allowPrintWeb: true }) },
      sellerProfile: {
        findMany: async () => [{ id: 'seller-1', businessName: 'Alpine Sports', membership: { user: { firstName: null, lastName: null, email: null, phone: null } } }],
      },
    };
    const sellers = await new LegacyTicketService(prisma as never).sellersWithRanges('org-1', 'swap-1');
    expect(sellers.map((s) => [s.displayName, s.ranges.length])).toEqual([['Alpine Sports', 0]]);
  });

  it('gives a shop that holds tickets a generated SKU, and refuses a ticket number', async () => {
    const created: Record<string, unknown>[] = [];
    const prisma = {
      sellerProfile: { findFirst: async () => ({ id: 'seller-1', businessName: 'Alpine Sports' }) },
      skiSwap: { findFirst: async () => ({ id: 'swap-1', allowLegacyWeb: false, allowPrintWeb: true }) },
    };
    const ticketService = { isLegacySeller: async () => true };
    const items = { createAtStation: async (_o: string, _s: string, data: Record<string, unknown>) => { created.push(data); return data; } };
    const svc = new SellerSelfService(prisma as never, items as never, {} as never, {} as never, {} as never, ticketService as never);
    await svc.createItem('org-1', 'user-1', { swapId: 'swap-1', categoryId: 'cat-skis', priceCents: 2500, quantity: 1 });
    expect(created[0].sku).toBeUndefined();
    await expect(svc.createItem('org-1', 'user-1', { swapId: 'swap-1', categoryId: 'cat-skis', priceCents: 2500, quantity: 1, sku: '67001' }))
      .rejects.toThrow(/doesn’t take legacy tickets on the web/);
  });
});
