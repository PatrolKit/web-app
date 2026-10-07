import { IndemnificationLookupService } from './indemnification-lookup.service';

/**
 * The answer for a model (Plan 44 D4), and what a patrol that hasn't declared
 * NSSRA membership sees (D5), against a fake Prisma.
 */

type Node = { id: string; parentId: string | null; kind: 'CATEGORY' | 'ATTRIBUTE' | 'VALUE'; label: string; orgId: string | null; status?: string; retiredAt?: Date | null; displayOrder?: number };

const nodes: Node[] = [
  { id: 'bindings', parentId: null, kind: 'CATEGORY', label: 'Bindings', orgId: null },
  { id: 'type', parentId: 'bindings', kind: 'ATTRIBUTE', label: 'Type', orgId: null },
  { id: 'type-skis', parentId: 'type', kind: 'VALUE', label: 'Skis', orgId: null },
  { id: 'mfr', parentId: 'type-skis', kind: 'ATTRIBUTE', label: 'Manufacturer', orgId: null },
  { id: 'maple', parentId: 'mfr', kind: 'VALUE', label: 'Maple', orgId: null },
  { id: 'larch', parentId: 'mfr', kind: 'VALUE', label: 'Larch', orgId: null },
  { id: 'elm', parentId: 'mfr', kind: 'VALUE', label: 'Elm', orgId: null },
  { id: 'maple-model', parentId: 'maple', kind: 'ATTRIBUTE', label: 'Model', orgId: null },
  { id: 'larch-model', parentId: 'larch', kind: 'ATTRIBUTE', label: 'Model', orgId: null },
  { id: 'elm-model', parentId: 'elm', kind: 'ATTRIBUTE', label: 'Model', orgId: null },
  { id: 'glade', parentId: 'maple-model', kind: 'VALUE', label: 'Glade 13 ID', orgId: null },
  { id: 'lumen', parentId: 'maple-model', kind: 'VALUE', label: 'Lumen', orgId: null },
  { id: 'mystery', parentId: 'maple-model', kind: 'VALUE', label: 'Mystery 9', orgId: 'org-1' },
  { id: 'pine', parentId: 'larch-model', kind: 'VALUE', label: 'Pine 2.0 15 GW', orgId: null },
  { id: 'flow', parentId: 'larch-model', kind: 'VALUE', label: 'SRX 12 Flow', orgId: null },
  { id: 'el10', parentId: 'elm-model', kind: 'VALUE', label: 'EM 10.0', orgId: null },
];

const entries = [
  { nodeId: 'glade', programKey: 'elevate', season: '2025-26', status: 'LISTED', retail: true, rental: false, demo: false, currentLine: true, nonIso: false, source: 'MANUFACTURER', sourceRef: 'Maple retail sheet', note: null },
  { nodeId: 'glade', programKey: 'elevate', season: '2024-25', status: 'LISTED', retail: true, rental: false, demo: false, currentLine: true, nonIso: false, source: 'MANUFACTURER', sourceRef: null, note: null },
  { nodeId: 'lumen', programKey: 'elevate', season: '2023-24', status: 'LISTED', retail: true, rental: false, demo: false, currentLine: false, nonIso: false, source: 'MANUFACTURER', sourceRef: null, note: null },
  { nodeId: 'pine', programKey: 'rowan', season: '2025-26', status: 'LISTED', retail: true, rental: false, demo: false, currentLine: true, nonIso: false, source: 'NSSRA', sourceRef: 'Combined list p.56', note: null },
  { nodeId: 'flow', programKey: 'rowan', season: '2025-26', status: 'FINAL_SEASON', retail: false, rental: false, demo: false, currentLine: false, nonIso: false, source: 'NSSRA', sourceRef: null, note: 'Classic Grip toe piece' },
  // Elm's sheet hasn't arrived for 2025-26: its program is still on 2024-25.
  { nodeId: 'el10', programKey: 'elm', season: '2024-25', status: 'LISTED', retail: false, rental: false, demo: false, currentLine: null, nonIso: false, source: 'NSSRA', sourceRef: null, note: null },
];

const programs = [
  { key: 'elevate', name: 'Elevate (Maple)', notes: 'Dealer terms.', latestSeason: '2025-26' },
  { key: 'rowan', name: 'Rowan Group', notes: '', latestSeason: '2025-26' },
  { key: 'elm', name: 'Elm', notes: '', latestSeason: '2024-25' },
];

function makeService(nssraMember: boolean) {
  const visible = (n: Node, where: Record<string, unknown>) => {
    const or = where.OR as { orgId: string | null }[] | undefined;
    if (or && !or.some((o) => o.orgId === n.orgId)) return false;
    if (where.parentId !== undefined) {
      const p = where.parentId as string | { in: string[] };
      if (typeof p === 'string' ? n.parentId !== p : !p.in.includes(n.parentId as string)) return false;
    }
    if (where.kind !== undefined) {
      const k = where.kind as string | { in: string[] };
      if (typeof k === 'string' ? n.kind !== k : !k.in.includes(n.kind)) return false;
    }
    if (where.orgId === null && n.orgId !== null) return false;
    return true;
  };
  const prisma = {
    skiSwapSettings: { findUnique: async () => ({ nssraMember }) },
    bindingIndemnificationProgram: { findMany: async () => programs },
    taxonomyNode: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => nodes.filter((n) => visible(n, where)),
    },
    bindingIndemnification: {
      findMany: async ({ where }: { where: { nodeId: { in: string[] } } }) =>
        entries.filter((e) => where.nodeId.in.includes(e.nodeId)).sort((a, b) => b.season.localeCompare(a.season)),
    },
  };
  const taxonomy = { bindingManufacturerAttribute: async () => ({ id: 'mfr' }) };
  return new IndemnificationLookupService(prisma as never, taxonomy as never);
}

describe('the answer for a model (D4)', () => {
  const service = makeService(true);

  it('is indemnified for a model on its program\'s latest list, with that season\'s lines', async () => {
    const [glade] = await service.search('org-1', 'glade');
    expect(glade).toMatchObject({ answer: 'indemnified', season: '2025-26', lines: ['retail'], program: { key: 'elevate' } });
  });

  it('is final_season when the maker says so, with the note', async () => {
    const [flow] = await service.search('org-1', 'flow');
    expect(flow).toMatchObject({ answer: 'final_season', season: '2025-26', note: 'Classic Grip toe piece' });
  });

  it('is lapsed for a model off its program\'s latest list, naming the last season it was on', async () => {
    const [lumen] = await service.search('org-1', 'lumen');
    expect(lumen).toMatchObject({ answer: 'lapsed', season: '2025-26', lastListedSeason: '2023-24' });
  });

  it('is not lapsed for a brand whose program lags the others', async () => {
    const [el10] = await service.search('org-1', 'em 10');
    expect(el10).toMatchObject({ answer: 'indemnified', season: '2024-25' });
  });

  it('is not_listed for a model with no entry ever, including a patrol\'s own', async () => {
    const [mystery] = await service.search('org-1', 'mystery');
    expect(mystery).toMatchObject({ answer: 'not_listed', season: null, program: null });
  });

  it('lists a maker\'s models with their answers, and the makers with counts', async () => {
    const models = await service.models('org-1', 'maple');
    expect(models.map((m) => [m.model, m.answer])).toEqual([['Glade 13 ID', 'indemnified'], ['Lumen', 'lapsed'], ['Mystery 9', 'not_listed']]);
    const { manufacturers, latestSeason, nssraMember } = await service.manufacturers('org-1');
    expect(latestSeason).toBe('2025-26');
    expect(nssraMember).toBe(true);
    expect(manufacturers.find((m) => m.label === 'Maple')).toMatchObject({ models: 3, listed: 1, programs: [{ key: 'elevate', name: 'Elevate (Maple)' }] });
    expect(manufacturers.find((m) => m.label === 'Larch')).toMatchObject({ models: 2, listed: 2 });
  });

  it('details a model with every season, and the program\'s notes', async () => {
    const detail = await service.model('org-1', 'glade');
    expect(detail.entries.map((e) => e.season)).toEqual(['2025-26', '2024-25']);
    expect(detail.entries[0]).toMatchObject({ source: 'manufacturer', sourceRef: 'Maple retail sheet' });
    expect(detail.programNotes).toBe('Dealer terms.');
    expect(detail.hiddenEntries).toBe(0);
  });

  it('refuses a node that is not a binding model', async () => {
    await expect(service.model('org-1', 'maple')).rejects.toThrow(/Not a binding model/);
  });

  it('searches by tokens across maker and model, in brand then model order', async () => {
    const hits = await service.search('org-1', 'larch');
    expect(hits.map((h) => h.model)).toEqual(['Pine 2.0 15 GW', 'SRX 12 Flow']);
    expect(await service.search('org-1', '')).toEqual([]);
  });
});

describe('a patrol that has not declared NSSRA membership (D5)', () => {
  const service = makeService(false);

  it('still sees the maker-published entries', async () => {
    const [glade] = await service.search('org-1', 'glade');
    expect(glade.answer).toBe('indemnified');
  });

  it('gets unavailable, never not_listed, for a model whose entries are all NSSRA-sourced', async () => {
    const [pine] = await service.search('org-1', 'pine');
    expect(pine).toMatchObject({ answer: 'unavailable', season: null });
    const detail = await service.model('org-1', 'pine');
    expect(detail.entries).toEqual([]);
    expect(detail.hiddenEntries).toBe(1);
  });

  it('says so in the manufacturers response', async () => {
    const { nssraMember, manufacturers } = await service.manufacturers('org-1');
    expect(nssraMember).toBe(false);
    expect(manufacturers.find((m) => m.label === 'Larch')).toMatchObject({ listed: 0, programs: [] });
  });
});
