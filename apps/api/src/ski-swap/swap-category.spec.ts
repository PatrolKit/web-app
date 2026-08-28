import { SwapService } from './swap.service';

/**
 * Whether creating a swap adopts the Square category it already made, or makes
 * another one beside it.
 *
 * Against a stub rather than Square: the failure this covers is extra objects
 * appearing in a real shop's catalogue, and a test that had to create them to
 * prove they were not created twice would be the bug.
 */

type Category = {
  id: string;
  type: 'CATEGORY';
  categoryData: { name: string; parentCategory?: { id: string }; isTopLevel?: boolean };
};

/** Enough of the Square client for the category lookup, and a record of writes. */
function stubClient(existing: Category[]) {
  const upserts: { name?: string; parent?: string }[] = [];
  let nextId = 0;
  return {
    upserts,
    catalog: {
      list: async () => existing,
      object: {
        upsert: async (req: {
          object: { categoryData?: { name?: string; parentCategory?: { id?: string } } };
        }) => {
          const created: Category = {
            id: `made-${++nextId}`,
            type: 'CATEGORY',
            categoryData: {
              name: req.object.categoryData?.name ?? '',
              parentCategory: req.object.categoryData?.parentCategory as { id: string } | undefined,
            },
          };
          upserts.push({
            name: created.categoryData.name,
            parent: created.categoryData.parentCategory?.id,
          });
          existing.push(created);
          return { catalogObject: created };
        },
      },
    },
  };
}

/** The private lookup, reached the way the service's own callers reach it. */
function findOrCreate(service: SwapService, client: unknown, parentId: string, title: string) {
  return (
    service as unknown as {
      findOrCreateSwapCategory: (c: unknown, p: string, t: string) => Promise<string>;
    }
  ).findOrCreateSwapCategory(client, parentId, title);
}

describe('swap category resolution', () => {
  const service = Object.create(SwapService.prototype) as SwapService;
  const PARENT = 'patrolkit-parent';

  it('creates the category when the catalogue has none', async () => {
    const client = stubClient([]);
    const id = await findOrCreate(service, client, PARENT, 'Ski Swap 2026');

    expect(id).toBe('made-1');
    expect(client.upserts).toEqual([{ name: 'Ski Swap 2026', parent: PARENT }]);
  });

  it('adopts the existing category instead of making a second', async () => {
    const client = stubClient([
      {
        id: 'already-here',
        type: 'CATEGORY',
        categoryData: { name: 'Ski Swap 2026', parentCategory: { id: PARENT } },
      },
    ]);

    const id = await findOrCreate(service, client, PARENT, 'Ski Swap 2026');

    expect(id).toBe('already-here');
    // The whole point: nothing was written to the catalogue.
    expect(client.upserts).toEqual([]);
  });

  it('does not adopt a same-named category from outside PatrolKit', async () => {
    // A shop may already file things under the season. Taking that category
    // over would put consigned items into the shop's own inventory grouping.
    const client = stubClient([
      {
        id: 'shops-own',
        type: 'CATEGORY',
        categoryData: { name: 'Ski Swap 2026', parentCategory: { id: 'someone-elses-parent' } },
      },
    ]);

    const id = await findOrCreate(service, client, PARENT, 'Ski Swap 2026');

    expect(id).toBe('made-1');
    expect(client.upserts).toEqual([{ name: 'Ski Swap 2026', parent: PARENT }]);
  });

  it('does not adopt a top-level category of the same name', async () => {
    const client = stubClient([
      {
        id: 'top-level',
        type: 'CATEGORY',
        categoryData: { name: 'Ski Swap 2026', isTopLevel: true },
      },
    ]);

    const id = await findOrCreate(service, client, PARENT, 'Ski Swap 2026');

    expect(id).toBe('made-1');
  });

  it('creates a separate category per swap title', async () => {
    const client = stubClient([
      {
        id: 'last-year',
        type: 'CATEGORY',
        categoryData: { name: 'Ski Swap 2025', parentCategory: { id: PARENT } },
      },
    ]);

    const id = await findOrCreate(service, client, PARENT, 'Ski Swap 2026');

    expect(id).toBe('made-1');
    expect(client.upserts).toEqual([{ name: 'Ski Swap 2026', parent: PARENT }]);
  });
});
