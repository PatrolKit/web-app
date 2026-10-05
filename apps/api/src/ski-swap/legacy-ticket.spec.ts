import { isUntouched, LegacyTicketService, runsOf, ticketNumberOf } from './legacy-ticket.service';

/**
 * Legacy tickets as items (Plan 38).
 *
 * Issuing a block creates its tickets, so the items are the whole record: a
 * shop's tickets are the ticket items it holds, and "untouched" (nobody has
 * described or priced it) is what lets the shop fill one in, once.
 */

describe('reading a SKU as a ticket number', () => {
  it('takes a bare number', () => {
    expect(ticketNumberOf('67169')).toBe(67169);
  });

  it('refuses one of ours', () => {
    // Our own SKUs share the column, so anything shaped like SS26-A-0001 has to
    // read as "not a ticket" rather than as a number with punctuation.
    expect(ticketNumberOf('SS26-A-0001')).toBeNull();
    expect(ticketNumberOf('SS26-0042')).toBeNull();
  });

  it('refuses anything that is not only digits', () => {
    expect(ticketNumberOf('67169 ')).toBeNull();
    expect(ticketNumberOf('67-169')).toBeNull();
    expect(ticketNumberOf('')).toBeNull();
  });

  it('reads a number that is not zero-padded as itself', () => {
    // These pads are not padded, so 999 and 1000 are three and four digits and
    // both are ordinary numbers.
    expect(ticketNumberOf('999')).toBe(999);
    expect(ticketNumberOf('1000')).toBe(1000);
  });
});

describe('runs of numbers', () => {
  it('groups consecutive numbers, in order, whatever order they came in', () => {
    expect(runsOf([67003, 67001, 67002, 67010, 999, 1000])).toEqual([
      { startNumber: 999, endNumber: 1000 },
      { startNumber: 67001, endNumber: 67003 },
      { startNumber: 67010, endNumber: 67010 },
    ]);
  });

  it('is nothing for nothing', () => {
    expect(runsOf([])).toEqual([]);
  });
});

describe('an untouched ticket', () => {
  const issued = { sku: '67169', name: 'Item #67169', priceCents: null, categoryId: null, description: null };

  it('is one still as issued', () => {
    expect(isUntouched(issued)).toBe(true);
  });

  it('is touched by a price, a type, notes or a name', () => {
    expect(isUntouched({ ...issued, priceCents: 4500 })).toBe(false);
    expect(isUntouched({ ...issued, categoryId: 'cat-skis' })).toBe(false);
    expect(isUntouched({ ...issued, description: '170cm' })).toBe(false);
    expect(isUntouched({ ...issued, name: 'Red skis' })).toBe(false);
  });
});

// ─── A shop's tickets, from its items ────────────────────────────────────────

const ticket = (n: number, over: Record<string, unknown> = {}) => ({
  id: `t${n}`, sku: String(n), name: `Item #${n}`, priceCents: null, categoryId: null, description: null, ...over,
});

function service(items: Record<string, unknown>[], swap = { allowLegacyWeb: true, allowPrintWeb: true }) {
  const prisma = {
    swapItem: {
      findMany: async () => items,
      findFirst: async ({ where }: { where: { sku: string } }) => {
        const hit = items.find((i) => i.sku === where.sku);
        return hit ? { seller: hit.seller ?? null } : null;
      },
    },
    skiSwap: { findUnique: async () => swap, findFirst: async () => swap },
  };
  return new LegacyTicketService(prisma as never);
}

describe('what the shop’s form offers', () => {
  it('is the runs it holds, and its lowest untouched ticket', async () => {
    const held = [ticket(67000, { priceCents: 2000 }), ticket(67001), ticket(67002), ticket(67005)];
    await expect(service(held).formState('swap-1', 'seller-1')).resolves.toEqual({
      ranges: [{ startNumber: 67000, endNumber: 67002 }, { startNumber: 67005, endNumber: 67005 }],
      suggested: 67001, exhausted: false, webTicketsOnly: false,
    });
  });

  it('is exhausted only when every ticket is described', async () => {
    const held = [ticket(67000, { priceCents: 2000 }), ticket(67001, { categoryId: 'cat' })];
    await expect(service(held).formState('swap-1', 'seller-1')).resolves.toMatchObject({ suggested: null, exhausted: true });
  });

  it('leaves out items that aren’t tickets', async () => {
    const held = [ticket(67000), { ...ticket(0), sku: 'SS26-A-0001', name: 'Item #SS26-A-0001' }];
    await expect(service(held).formState('swap-1', 'seller-1')).resolves.toMatchObject({
      ranges: [{ startNumber: 67000, endNumber: 67000 }],
    });
  });
});

describe('a shop naming one of its tickets', () => {
  it('finds it by number', async () => {
    await expect(service([ticket(67001)]).ownTicket('swap-1', 'seller-1', '67001')).resolves.toMatchObject({ id: 't67001' });
  });

  it('is refused a number it doesn’t hold, told which it does', async () => {
    await expect(service([ticket(67000), ticket(67001)]).ownTicket('swap-1', 'seller-1', '68000'))
      .rejects.toThrow('68000 isn’t one of your tickets. Yours are 67000–67001.');
  });

  it('is refused something that isn’t a ticket number', async () => {
    await expect(service([ticket(67001)]).ownTicket('swap-1', 'seller-1', 'SS26-A-0001')).rejects.toThrow(/just the digits/);
  });
});

describe('a file of ticket rows', () => {
  const row = (sku: string, priceCents: number | null = 1000) => ({ sku, priceCents });
  const rules = { generateSkus: false, webTicketsOnly: false };

  it('fills in the tickets it names, saying which', async () => {
    const results = await service([ticket(67001), ticket(67002)])
      .checkImportRows('swap-1', 'seller-1', [row('67001'), row('67002', null)], rules);
    expect(results).toEqual([
      { line: 2, sku: '67001', outcome: 'ok', itemId: 't67001' },
      { line: 3, sku: '67002', outcome: 'ok', itemId: 't67002' },
    ]);
  });

  it('refuses a number the seller doesn’t hold, and a repeat', async () => {
    const results = await service([ticket(67001)])
      .checkImportRows('swap-1', 'seller-1', [row('67001'), row('67009'), row('67001')], rules);
    expect(results.map((r) => r.error ?? r.outcome)).toEqual([
      'ok', '67009 isn’t one of this seller’s tickets. Theirs are 67001.', 'Ticket 67001 is also on line 2.',
    ]);
  });

  it('holds the shop’s own file to tickets nobody has described; staff aren’t', async () => {
    const held = [ticket(67001, { priceCents: 2500 })];
    const own = await service(held).checkImportRows('swap-1', 'seller-1', [row('67001')], { ...rules, shopOwn: true });
    expect(own[0].error).toBe('67001 is already described. Ask the swap’s staff to change it.');
    const staff = await service(held).checkImportRows('swap-1', 'seller-1', [row('67001')], rules);
    expect(staff[0]).toMatchObject({ outcome: 'ok', itemId: 't67001' });
  });
});

describe('whose ticket a number already is', () => {
  it('names the seller holding it, or says nobody does', async () => {
    const shop = { businessName: 'Stowe Sports', membership: { user: { firstName: null, lastName: null, email: null, phone: null } } };
    const svc = service([{ ...ticket(67001), seller: shop }]);
    await expect(svc.takenBy('swap-1', '67001')).resolves.toEqual({ sellerName: 'Stowe Sports' });
    await expect(svc.takenBy('swap-1', '67002')).resolves.toBeNull();
  });
});
