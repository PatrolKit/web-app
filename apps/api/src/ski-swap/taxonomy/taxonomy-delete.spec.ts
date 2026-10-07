import { TaxonomyService } from './taxonomy.service';

/**
 * A patrol deleting a value it added. Unused, it goes; in use, or carrying
 * follow-up questions, it's refused with retiring as the way out, because a
 * node any item points at is retired, never deleted (Plan 19).
 */
function harness(node: Record<string, unknown>, opts: { items?: number; children?: number; listed?: number } = {}) {
  const deleted: string[] = [];
  const cleared: unknown[] = [];
  const prisma = {
    taxonomyNode: {
      findFirst: async () => node,
      count: async () => opts.children ?? 0,
      delete: async ({ where }: { where: { id: string } }) => { deleted.push(where.id); return node; },
    },
    swapItemAttribute: {
      // Only live items count; the service has to ask for that.
      count: async ({ where }: { where: { item?: { deletedAt: null } } }) =>
        where.item?.deletedAt === null ? opts.items ?? 0 : 99,
      deleteMany: async ({ where }: { where: unknown }) => { cleared.push(where); return { count: 1 }; },
    },
    // Seasons on an indemnified bindings list are a use too (Plan 44 D9).
    bindingIndemnification: { count: async () => opts.listed ?? 0 },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    skiSwapSettings: { upsert: async () => ({}) },
  };
  return { service: new TaxonomyService(prisma as never, {} as never), deleted, cleared };
}
const value = (over: Record<string, unknown> = {}) => ({ id: 'v1', kind: 'VALUE', orgId: 'org-1', status: 'APPROVED', label: 'bindings', ...over });

describe('deleting a patrol’s own value', () => {
  it('deletes an approved value nothing uses', async () => {
    const { service, deleted } = harness(value());
    await service.discard('org-1', 'v1');
    expect(deleted).toEqual(['v1']);
  });

  it('still deletes a pending one, as the queue does', async () => {
    const { service, deleted } = harness(value({ status: 'PENDING' }));
    await service.discard('org-1', 'v1');
    expect(deleted).toEqual(['v1']);
  });

  it('deletes one only deleted items used, clearing their answers first', async () => {
    // A deleted item's answer still points at the value; it's not a use.
    const { service, deleted, cleared } = harness(value(), { items: 0 });
    await service.discard('org-1', 'v1');
    expect(cleared).toEqual([{ valueId: 'v1', item: { deletedAt: { not: null } } }]);
    expect(deleted).toEqual(['v1']);
  });

  it('refuses one items use, pointing at retiring', async () => {
    const { service, deleted } = harness(value(), { items: 3 });
    await expect(service.discard('org-1', 'v1')).rejects.toThrow(/3 items use this\. Retire it instead/);
    expect(deleted).toEqual([]);
  });

  it('refuses one with follow-up questions under it', async () => {
    const { service } = harness(value(), { children: 1 });
    await expect(service.discard('org-1', 'v1')).rejects.toThrow(/follow-up questions/);
  });

  it('refuses a binding model that is on an indemnified list (Plan 44 D9)', async () => {
    const { service, deleted } = harness(value(), { listed: 2 });
    await expect(service.discard('org-1', 'v1')).rejects.toThrow(/indemnified bindings list/);
    expect(deleted).toEqual([]);
  });

  it('refuses the shared list, and anything not a value', async () => {
    await expect(harness(value({ orgId: null })).service.discard('org-1', 'v1')).rejects.toThrow(/not this org/);
    await expect(harness(value({ kind: 'ATTRIBUTE' })).service.discard('org-1', 'v1')).rejects.toThrow(/Only a value/);
  });
});
