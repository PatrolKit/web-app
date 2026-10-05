import { LegacyTicketService } from './legacy-ticket.service';

/**
 * Reading a shop's spreadsheet, and deciding whether it may be written.
 *
 * The parser and the rules are separable from everything they touch, so these
 * run against the real service with a stub database. What they cover is the two
 * things that changed: a description is now its own column rather than another
 * word for the name, and checking a file no longer writes it.
 */

/**
 * Just enough Prisma for the checks: the seller's issued tickets, as items
 * (Plan 38), and which of them somebody has already described.
 */
function service(opts: {
  ranges?: { startNumber: number; endNumber: number }[];
  describedSkus?: string[];
} = {}) {
  const items: Record<string, unknown>[] = [];
  for (const r of opts.ranges ?? [{ startNumber: 67000, endNumber: 67499 }]) {
    for (let n = r.startNumber; n <= r.endNumber; n++) {
      const sku = String(n);
      const described = opts.describedSkus?.includes(sku);
      items.push({
        id: `t${n}`, sku, name: described ? 'Boots' : `Item #${n}`,
        priceCents: described ? 18000 : null, categoryId: null, description: null,
      });
    }
  }
  const prisma = { swapItem: { findMany: async () => items } };
  return new LegacyTicketService(prisma as never);
}

const csv = (text: string) => Buffer.from(text, 'utf8');

/** Today's rules: every row a ticket, nothing generated. */
const TICKETS = { generateSkus: false, webTicketsOnly: false };

describe('reading a shop’s file', () => {
  it('takes a description as its own column', async () => {
    const { rows } = service().parseItemCsv(
      csv('sku,price,name,description\n67169,180.00,Salomon boots,27.5 mondo\n'),
    );

    expect(rows[0]).toEqual({
      sku: '67169', priceCents: 18000, name: 'Salomon boots', description: '27.5 mondo',
    });
  });

  it('no longer reads a description as the name', async () => {
    // It used to. A shop writing "177cm, small topsheet scratch" meant it as the
    // detail under the title, and Square shows a description to buyers.
    const { rows } = service().parseItemCsv(
      csv('sku,price,description\n67169,180.00,177cm small topsheet scratch\n'),
    );

    expect(rows[0].name).toBeUndefined();
    expect(rows[0].description).toBe('177cm small topsheet scratch');
  });

  it('accepts the words a shop is likely to have typed', async () => {
    const { rows } = service().parseItemCsv(
      csv('ticket,cost,item,notes\n67169,180.00,Boots,27.5\n'),
    );

    expect(rows[0]).toEqual({ sku: '67169', priceCents: 18000, name: 'Boots', description: '27.5' });
  });

  it('reads a price however it was written', async () => {
    const { rows } = service().parseItemCsv(csv('sku,price\n67169,"$1,250.00"\n'));

    expect(rows[0].priceCents).toBe(125000);
  });

  it('keeps a quoted comma inside a description', async () => {
    const { rows } = service().parseItemCsv(
      csv('sku,price,description\n67169,180.00,"170cm, edges good"\n'),
    );

    expect(rows[0].description).toBe('170cm, edges good');
  });

  it('says what to do about an unquoted comma instead of failing opaquely', async () => {
    // What a hand-typed file looks like. The parser's own words are "Invalid
    // Record Length", which reached staff as a 500.
    expect(() =>
      service().parseItemCsv(csv('sku,price,description\n67169,180.00,170cm, edges good\n')),
    ).toThrow('has to be in quotes');
  });

  it('leaves both text columns empty when the file has neither', async () => {
    const { rows } = service().parseItemCsv(csv('sku,price\n67169,180.00\n'));

    expect(rows[0].name).toBeUndefined();
    expect(rows[0].description).toBeUndefined();
  });

  it('reads a file with no sku column as rows without tickets (Plan 31)', () => {
    // Each row then gets a generated SKU, or an error saying it needs a ticket.
    expect(service().parseItemCsv(csv('price,name\n180.00,Boots\n')).rows).toEqual([
      { sku: '', name: 'Boots', description: undefined, priceCents: 18000 },
    ]);
  });

  it('reads a file with no price column as tickets priced later (Plan 32)', () => {
    expect(service().parseItemCsv(csv('sku,name\n67169,Boots\n')).rows).toEqual([
      { sku: '67169', name: 'Boots', description: undefined, priceCents: null },
    ]);
  });

  it('reads a blank price as none, and anything else that isn’t an amount as one to refuse', () => {
    const { rows } = service().parseItemCsv(csv('sku,price\n67169,\n67170,$\n67171,abc\n67172,$45\n'));
    expect(rows.map((r) => r.priceCents)).toEqual([null, NaN, NaN, 4500]);
  });
});

describe('judging the rows before anything is written', () => {
  const row = (sku: string, priceCents = 18000) => ({ sku, priceCents });

  it('passes a file whose numbers are all the seller’s, naming the ticket each fills in', async () => {
    const results = await service().checkImportRows('swap-1', 'seller-1', [
      row('67169'), row('67170'),
    ], TICKETS);

    expect(results.map((r) => [r.outcome, r.itemId])).toEqual([['ok', 't67169'], ['ok', 't67170']]);
  });

  it('refuses a number outside their blocks, and says whose they are', async () => {
    // The check that turns picking the wrong shop into a failure rather than a
    // mess: another shop's file fails on its first row and every row after.
    const results = await service().checkImportRows('swap-1', 'seller-1', [row('68001')], TICKETS);

    expect(results[0].outcome).toBe('error');
    expect(results[0].error).toContain('isn’t one of this seller’s tickets');
    expect(results[0].error).toContain('67000–67499');
  });

  it('refuses, from the shop’s own file, a ticket already described; staff may redo it', async () => {
    const shop = await service({ describedSkus: ['67169'] })
      .checkImportRows('swap-1', 'seller-1', [row('67169')], { ...TICKETS, shopOwn: true });
    expect(shop[0].error).toBe('67169 is already described. Ask the swap’s staff to change it.');

    const staff = await service({ describedSkus: ['67169'] }).checkImportRows('swap-1', 'seller-1', [row('67169')], TICKETS);
    expect(staff[0]).toMatchObject({ outcome: 'ok', itemId: 't67169' });
  });

  it('refuses the same number twice in one file, naming the earlier line', async () => {
    const results = await service().checkImportRows('swap-1', 'seller-1', [
      row('67169'), row('67170'), row('67169'),
    ], TICKETS);

    expect(results[2].error).toBe('Ticket 67169 is also on line 2.');
  });

  it('refuses a price that isn’t an amount', async () => {
    const results = await service().checkImportRows('swap-1', 'seller-1', [
      { sku: '67169', priceCents: NaN },
      { sku: '67170', priceCents: 0 },
    ], TICKETS);

    expect(results.map((r) => r.error)).toEqual([
      'A price has to be an amount above $0.',
      'A price has to be an amount above $0.',
    ]);
  });

  it('lets a ticket row wait for its price (Plan 32)', async () => {
    const results = await service().checkImportRows('swap-1', 'seller-1', [
      { sku: '67169', priceCents: null },
    ], TICKETS);

    expect(results[0]).toMatchObject({ outcome: 'ok' });
  });

  it('still needs a price on a row that gets a generated SKU', async () => {
    const results = await service().checkImportRows('swap-1', 'seller-1', [
      { sku: '', priceCents: null },
      { sku: '', priceCents: 2500 },
    ], { ...TICKETS, generateSkus: true });

    expect(results.map((r) => [r.outcome, r.error ?? null])).toEqual([
      ['error', 'A row without a ticket needs a price.'],
      ['ok', null],
    ]);
  });

  it('refuses a ticket number that is not just digits', async () => {
    const results = await service().checkImportRows('swap-1', 'seller-1', [row('SS26-A-0001')], TICKETS);

    expect(results[0].error).toContain('just the digits');
  });

  it('refuses a seller who holds no tickets in this swap', async () => {
    await expect(service({ ranges: [] }).checkImportRows('swap-1', 'seller-1', [row('67169')], TICKETS))
      .rejects.toThrow('no tickets for this swap');
  });

  it('reports every bad row, not just the first', async () => {
    // The whole file comes back so it can be fixed in one pass rather than one
    // upload at a time.
    const results = await service().checkImportRows('swap-1', 'seller-1', [
      row('68001'), row('67169'), row('68002'),
    ], TICKETS);

    expect(results.filter((r) => r.outcome === 'error')).toHaveLength(2);
  });

  it('judges out-of-order and skipped numbers on their merits', async () => {
    // A pad worked through out of order is exactly the file this exists to
    // accept; the high-water mark only decides what the form suggests.
    const results = await service().checkImportRows('swap-1', 'seller-1', [
      row('67400'), row('67001'), row('67250'),
    ], TICKETS);

    expect(results.every((r) => r.outcome === 'ok')).toBe(true);
  });
});
