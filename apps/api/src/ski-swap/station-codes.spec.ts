import { StationService } from './station.service';

/**
 * A station's letter is held while it's live and released when it's retired:
 * `liveCode` carries the unique index, `code` keeps the history.
 */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'st-1', orgId: 'org-1', name: 'Station 1', code: 'A', liveCode: 'A',
  attendantDeviceId: null, bridgeDeviceId: null, deletedAt: null,
  createdAt: new Date(), updatedAt: new Date(), attendant: null, bridge: null, ...over,
});

function harness(opts: { codes?: string[]; clashes?: number } = {}) {
  const writes: Record<string, unknown>[] = [];
  let clashes = opts.clashes ?? 0;
  const codes = [...(opts.codes ?? ['A'])];
  const prisma = {
    checkinStation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        if (clashes-- > 0) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        return row(data);
      },
      findFirst: async () => row(),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return row(data);
      },
    },
  };
  const sku = { allocateCode: async () => codes.shift() ?? 'Z' };
  return { service: new StationService(prisma as never, sku as never), writes };
}

describe('station letters', () => {
  it('a new station holds its letter as live', async () => {
    const { service, writes } = harness({ codes: ['C'] });
    await service.create('org-1', 'Station 3');
    expect(writes[0]).toMatchObject({ code: 'C', liveCode: 'C' });
  });

  it('a retired station keeps its letter as history, and lets it go', async () => {
    const { service, writes } = harness();
    await service.remove('org-1', 'st-1');
    expect(writes[0]).toMatchObject({ liveCode: null });
    expect(writes[0]).not.toHaveProperty('code');
  });

  it('two stations added at once: the one refused takes the next letter', async () => {
    const { service, writes } = harness({ codes: ['B', 'C'], clashes: 1 });
    await service.create('org-1', 'Station 4');
    expect(writes.map((w) => w.code)).toEqual(['B', 'C']);
  });
});
