import { LegacyTicketService } from './legacy-ticket.service';

/**
 * Reading a shop's spreadsheet, and deciding whether it may be written.
 *
 * The parser and the rules are separable from everything they touch, so these
 * run against the real service with a stub database. What they cover is the two
 * things that changed: a description is now its own column rather than another
 * word for the name, and checking a file no longer writes it.
 */

/** Just enough Prisma for the checks: who holds what, and what is spent. */
function service(opts: {
  ranges?: { startNumber: number; endNumber: number }[];
  usedSkus?: string[];
} = {}) {
  const prisma = {
    legacyTicketRange: {
      findMany: async () => opts.ranges ?? [{ startNumber: 67000, endNumber: 67499 }],
    },
    swapItem: {
      findMany: async () => (opts.usedSkus ?? []).map((sku) => ({ sku })),
    },
  };
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

  it('refuses a file with no price column', () => {
    expect(() => service().parseItemCsv(csv('sku,name\n67169,Boots\n'))).toThrow('"price" column');
  });
});

describe('judging the rows before anything is written', () => {
  const row = (sku: string, priceCents = 18000) => ({ sku, priceCents });

  it('passes a file whose numbers are all the seller’s', async () => {
    const results = await service().checkImportRows('swap-1', 'seller-1', [
      row('67169'), row('67170'),
    ], TICKETS);

    expect(results.every((r) => r.outcome === 'ok')).toBe(true);
  });

  it('refuses a number outside their blocks, and says whose they are', async () => {
    // The check that turns picking the wrong shop into a failure rather than a
    // mess: another shop's file fails on its first row and every row after.
    const results = await service().checkImportRows('swap-1', 'seller-1', [row('68001')], TICKETS);

    expect(results[0].outcome).toBe('error');
    expect(results[0].error).toContain('not one of this seller');
    expect(results[0].error).toContain('67000–67499');
  });

  it('refuses a number already on an item', async () => {
    const results = await service({ usedSkus: ['67169'] })
      .checkImportRows('swap-1', 'seller-1', [row('67169')], TICKETS);

    expect(results[0].error).toBe('Ticket 67169 is already on another item.');
  });

  it('refuses the same number twice in one file, naming the earlier line', async () => {
    const results = await service().checkImportRows('swap-1', 'seller-1', [
      row('67169'), row('67170'), row('67169'),
    ], TICKETS);

    expect(results[2].error).toBe('Ticket 67169 is also on line 2.');
  });

  it('refuses a row with no price', async () => {
    const results = await service().checkImportRows('swap-1', 'seller-1', [
      { sku: '67169', priceCents: NaN },
    ], TICKETS);

    expect(results[0].error).toBe('Every row needs a price.');
  });

  it('refuses a ticket number that is not just digits', async () => {
    const results = await service().checkImportRows('swap-1', 'seller-1', [row('SS26-A-0001')], TICKETS);

    expect(results[0].error).toContain('just the digits');
  });

  it('refuses a seller who holds no tickets in this swap', async () => {
    await expect(service({ ranges: [] }).checkImportRows('swap-1', 'seller-1', [row('67169')], TICKETS))
      .rejects.toThrow('no ticket ranges');
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
