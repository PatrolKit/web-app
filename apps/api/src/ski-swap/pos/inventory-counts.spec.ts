import { SquarePosAdapterFactory } from './square.pos.adapter';

/** Square answers at most 1,000 catalog ids per inventory read. */
function harness() {
  const calls: number[] = [];
  const client = {
    inventory: {
      batchGetCounts: async ({ catalogObjectIds }: { catalogObjectIds: string[] }) => {
        if (catalogObjectIds.length > 1000) throw new Error('ARRAY_LENGTH_TOO_LONG');
        calls.push(catalogObjectIds.length);
        // Iterable like Square's pager: every count, one per id.
        return (async function* () {
          for (const id of catalogObjectIds) yield { catalogObjectId: id, state: 'IN_STOCK', quantity: '1' };
        })();
      },
    },
  };
  const factory = new SquarePosAdapterFactory({ forOrg: async () => client } as never);
  return { adapter: factory.forOrg('org'), calls };
}

describe('reading stock for many items', () => {
  it('reads a shop of 2,219 items in calls of 1,000 and answers every one', async () => {
    const { adapter, calls } = harness();
    const ids = Array.from({ length: 2219 }, (_, i) => `v${i}`);
    const counts = await (await adapter)!.getInventoryCounts(ids, 'loc');
    expect(calls).toEqual([1000, 1000, 219]);
    expect(counts.size).toBe(2219);
  });

  it('makes no call for no items', async () => {
    const { adapter, calls } = harness();
    expect((await (await adapter)!.getInventoryCounts([], 'loc')).size).toBe(0);
    expect(calls).toEqual([]);
  });
});
