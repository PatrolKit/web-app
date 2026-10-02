import { ItemService } from './item.service';

/**
 * Accepting everything one seller is waiting on, when the set moves underneath.
 *
 * A shop can add a row at any moment — from its own dashboard, from a phone at
 * the table — and a volunteer can press Accept at any moment. So the set of
 * waiting items is not still while this runs, and the question is what happens
 * to a row that arrives in the gap.
 *
 * It used to be consigned and not pushed. The read took a snapshot, the update
 * re-ran the filter and caught the late row too, and the push was handed the
 * snapshot — so the row went consigned, never reached Square, and was not in
 * the count anybody saw. Sellable in name only, with nothing anywhere saying to
 * go and look.
 */

interface Row {
  id: string;
  orgId: string;
  swapId: string;
  sellerId: string;
  consignedAt: Date | null;
  consignedBy: string | null;
  deletedAt: Date | null;
}

function row(id: string): Row {
  return {
    id, orgId: 'org-1', swapId: 'swap-1', sellerId: 'seller-1',
    consignedAt: null, consignedBy: null, deletedAt: null,
  };
}

/**
 * Enough Prisma to run a batch consign, with a hook that fires between the read
 * and the write — which is the only place the race can happen.
 */
function harness(opts: { duringGap?: (rows: Row[]) => void } = {}) {
  const rows: Row[] = [row('a'), row('b')];
  const pushed: string[] = [];

  /**
   * `id` arrives two ways — a plain string, and `{ in: [...] }` for the batch.
   *
   * An earlier version of this skipped `id` entirely rather than handling both,
   * so every lookup returned the first row that matched on the other columns.
   * Two pushes of different items both reported the same one, and the test
   * asserting what reached Square passed by accident.
   */
  const matches = (r: Row, where: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'id' && v !== null && typeof v === 'object') {
        if (!(v as { in: string[] }).in.includes(r.id)) return false;
        continue;
      }
      if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
    }
    return true;
  };

  const prisma = {
    skiSwap: {
      findFirst: async () => ({
        id: 'swap-1', orgId: 'org-1', locationId: 'loc-1',
        title: 'Ski Swap 2026', squareCategoryId: 'cat-1',
      }),
    },
    swapItem: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const found = rows.filter((r) => matches(r, where)).map((r) => ({ id: r.id }));
        // The gap. A row landing here is the whole point of the test.
        opts.duringGap?.(rows);
        return found;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
      findFirstOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
        const found = rows.find((r) => matches(r, where));
        if (!found) throw new Error('not found');
        return { ...found, name: found.id, description: null, priceCents: 1, sku: found.id,
                 originalQuantity: 1, squareItemId: null, squareVariationId: null };
      },
      // The push re-reads the Square ids under its per-item lock before it
      // decides between create and update. Nothing here has been pushed yet.
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const found = rows.find((r) => matches(r, where));
        return found ? { squareItemId: null, squareVariationId: null } : null;
      },
      update: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id),
    },
    swapItemPhoto: { findMany: async () => [] },
  };

  // `sku` is the row id in this harness, so what Square was handed is legible
  // as the row it came from.
  const posFactory = {
    forOrg: async () => ({
      syncItem: async (item: { sku: string }) => {
        pushed.push(item.sku);
        return { posItemId: 'p', posVariationId: 'v', resolvedCategoryId: 'cat-1' };
      },
    }),
  };

  const service = new ItemService(
    prisma as unknown as never,
    posFactory as unknown as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never,
  );

  return { service, rows, pushed };
}

/** The pushes are deliberately not awaited by the caller, so let them settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('accepting everything a seller is waiting on', () => {
  it('accepts what it read, and puts it in the catalogue', async () => {
    const { service, rows, pushed } = harness();

    const result = await service.consignAllForSeller('org-1', 'swap-1', 'seller-1', 'staff-1');
    await settle();

    expect(result.consigned).toBe(2);
    expect(rows.every((r) => r.consignedAt !== null)).toBe(true);
    expect(rows.every((r) => r.consignedBy === 'staff-1')).toBe(true);
    // Consigned and in the catalogue are the same event. A test that checked
    // only the column would pass with nothing ever sent to Square.
    expect(pushed.sort()).toEqual(['a', 'b']);
  });

  it('leaves a row that arrived mid-press waiting, rather than half-accepting it', async () => {
    const { service, rows, pushed } = harness({
      duringGap: (all) => all.push(row('late')),
    });

    await service.consignAllForSeller('org-1', 'swap-1', 'seller-1', 'staff-1');
    await settle();

    const late = rows.find((r) => r.id === 'late')!;
    // Neither half happened to it. Being consigned without being pushed was
    // the actual defect: an item that reads as for sale and is not in Square.
    expect(pushed).not.toContain('late');
    // Not consigned. The alternative — consigned but never handed to Square —
    // is an item that says it is for sale and is not in the catalogue.
    expect(late.consignedAt).toBeNull();
    // And it is still visible as waiting, so the next press takes it.
    expect(rows.filter((r) => r.consignedAt === null)).toEqual([late]);
  });

  it('counts what it changed, not what it hoped to', async () => {
    // Somebody else got there first between the read and the write.
    const { service, rows } = harness({
      duringGap: (all) => { all[0].consignedAt = new Date('2026-01-01'); },
    });

    const result = await service.consignAllForSeller('org-1', 'swap-1', 'seller-1', 'staff-1');
    await settle();

    expect(result.consigned).toBe(1);
    // And the one they accepted keeps the time they accepted it.
    expect(rows[0].consignedAt).toEqual(new Date('2026-01-01'));
  });

  it('says there was nothing to do rather than pretending it did something', async () => {
    const { service, rows } = harness();
    for (const r of rows) r.consignedAt = new Date();

    expect(await service.consignAllForSeller('org-1', 'swap-1', 'seller-1', 'staff-1'))
      .toEqual({ consigned: 0 });
  });
});
