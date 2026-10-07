import {
  liveFirst,
  matchesQuery,
  planChangesAnything,
  normalizeModel,
  parseEntriesCsv,
  planImport,
  type ExistingEntry,
  type TreeSnapshot,
} from './indemnification-import';

/**
 * The seasonal import's reading and planning (Plan 44 D7, D8), with no
 * database: a CSV in, a plan out.
 */

const PROGRAMS = new Set(['elevate', 'rowan', 'amer']);

const csv = (...lines: string[]) =>
  ['program,manufacturer,model,season,status,lines,current_line,non_iso,source,source_ref,note', ...lines].join('\n');

const tree: TreeSnapshot = {
  manufacturerAttrId: 'mfr',
  manufacturers: [
    {
      id: 'maple', label: 'Maple', modelAttrId: 'maple-model',
      models: [{ id: 'glade', label: 'Glade 13 ID' }, { id: 'spruce', label: 'Spruce 10' }, { id: 'lumen', label: 'Lumen' }],
    },
    { id: 'larch', label: 'Larch', modelAttrId: null, models: [] },
  ],
};

const entry = (over: Partial<ExistingEntry>): ExistingEntry => ({
  nodeId: 'glade', programKey: 'elevate', season: '2024-25', status: 'LISTED', retail: true, rental: false,
  demo: false, currentLine: true, nonIso: false, source: 'MANUFACTURER', sourceRef: null, note: null, ...over,
});

describe('reading the entries CSV', () => {
  it('reads a row, lines joined with +, booleans as yes/no', () => {
    const { rows, errors } = parseEntriesCsv(
      csv('elevate,Maple,Glade 13 ID,2025-26,listed,retail+rental,yes,no,manufacturer,Maple retail sheet,'),
      PROGRAMS,
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      expect.objectContaining({
        line: 2, program: 'elevate', manufacturer: 'Maple', model: 'Glade 13 ID', season: '2025-26',
        status: 'LISTED', retail: true, rental: true, demo: false, currentLine: true, nonIso: false,
        source: 'MANUFACTURER', sourceRef: 'Maple retail sheet', note: null,
      }),
    ]);
  });

  it('refuses an unknown program, a bad season, a bad status, a bad source and a bad line, by line', () => {
    const { rows, errors } = parseEntriesCsv(
      csv(
        'tamarack,Hemlock,PR 11,2025-26,listed,retail,,,nssra,,',
        'elevate,Maple,Lumen,2025-27,listed,retail,,,nssra,,',
        'elevate,Maple,Lumen,25/26,listed,retail,,,nssra,,',
        'elevate,Maple,Lumen,2025-26,current,retail,,,nssra,,',
        'elevate,Maple,Lumen,2025-26,listed,retail,,,vendor,,',
        'elevate,Maple,Lumen,2025-26,listed,wholesale,,,nssra,,',
        'elevate,,Lumen,2025-26,listed,retail,,,nssra,,',
      ),
      PROGRAMS,
    );
    expect(rows).toEqual([]);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(errors[0].message).toMatch(/program "tamarack"/);
    expect(errors[1].message).toMatch(/doesn't run one year/);
    expect(errors[2].message).toMatch(/like 2025-26/);
  });

  it('accepts final_season, empty lines, and headers in any case', () => {
    const { rows, errors } = parseEntriesCsv(
      'Program,Manufacturer,Model,Season,Status,Lines,Current Line,Non ISO,Source,Source Ref,Note\n' +
        'rowan,Rowan,Aspen 100,2025-26,final_season,,,,nssra,p.60,Ends September 30 2026',
      PROGRAMS,
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ status: 'FINAL_SEASON', retail: false, rental: false, demo: false, currentLine: null, note: 'Ends September 30 2026' });
  });
});

describe('normalising a model name', () => {
  it('ignores case, accents, superscripts, punctuation and spacing', () => {
    expect(normalizeModel('TORQUE² 13 GW')).toBe('torque2 13 gw');
    expect(normalizeModel('Torque2  13 gw')).toBe('torque2 13 gw');
    expect(normalizeModel('N S/PRO Tilt² 10 MN')).toBe('n s pro tilt2 10 mn');
    expect(normalizeModel('Ridge 10 (6 pack toe)')).toBe('ridge 10 6 pack toe');
    expect(normalizeModel('Völkl')).toBe('volkl');
  });

  it('does not treat a prefix as the same model', () => {
    expect(normalizeModel('Glade 13')).not.toBe(normalizeModel('Glade 13 ID'));
  });
});

describe('matching a query', () => {
  it('needs every token to start some token of maker and model', () => {
    expect(matchesQuery('Maple Glade 13 ID', 'gla 13')).toBe(true);
    expect(matchesQuery('Maple Glade 13 ID', 'maple gla')).toBe(true);
    expect(matchesQuery('Maple Glade 13 ID', 'GLADE')).toBe(true);
    expect(matchesQuery('Maple Glade 13 ID', 'glade 14')).toBe(false);
    expect(matchesQuery('Tamarack TORQUE² 13 GW', 'torque2')).toBe(true);
    expect(matchesQuery('Tamarack TORQUE² 13 GW', 'orque')).toBe(false);
  });
});

describe('planning an import', () => {
  const programs = [{ key: 'elevate', latestSeason: '2024-25' }, { key: 'rowan', latestSeason: null }, { key: 'amer', latestSeason: null }];

  it('mints only what is missing: a maker, its Model question, and new models', () => {
    const { rows, errors } = parseEntriesCsv(
      csv(
        'elevate,MAPLE,GLADE 13 ID,2025-26,listed,retail,yes,,manufacturer,,',
        'elevate,Maple,Juniper 16 ID,2025-26,listed,retail,yes,,manufacturer,,',
        'rowan,Larch,Pine 2.0 15 GW,2025-26,listed,retail,yes,,nssra,,',
        'amer,Alder,N Stride 14 GW,2025-26,listed,retail+rental,yes,,nssra,,',
      ),
      PROGRAMS,
    );
    const plan = planImport(rows, errors, tree, [], programs);
    expect(plan.errors).toEqual([]);
    expect(plan.mintManufacturers.map((m) => m.label)).toEqual(['Alder']);
    // Larch exists but has no Model question yet; Alder is new and gets one too (in apply).
    expect(plan.mintModelAttributes).toEqual(['larch']);
    expect(plan.mintModels.map((m) => `${m.manufacturerLabel} ${m.label}`)).toEqual([
      'Alder N Stride 14 GW', 'Larch Pine 2.0 15 GW', 'Maple Juniper 16 ID',
    ]);
    // Glade matched the existing node, in any case.
    expect(plan.entries.find((e) => e.modelKey === 'glade 13 id')?.nodeId).toBe('glade');
    expect(plan.season).toBe('2025-26');
    expect(plan.programSeasons).toEqual(expect.arrayContaining([{ key: 'elevate', season: '2025-26' }, { key: 'rowan', season: '2025-26' }, { key: 'amer', season: '2025-26' }]));
  });

  it('merges two rows for one model and season: lines ORed, the maker\'s own sheet wins', () => {
    const { rows, errors } = parseEntriesCsv(
      csv(
        'elevate,Maple,Spruce 10,2025-26,listed,retail,yes,,nssra,Combined list p.33,',
        'elevate,Maple,Spruce 10,2025-26,listed,rental,no,,manufacturer,Maple rental sheet,',
      ),
      PROGRAMS,
    );
    const plan = planImport(rows, errors, tree, [], programs);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ retail: true, rental: true, currentLine: true, source: 'MANUFACTURER' });
    expect(plan.entries[0].sourceRef).toBe('Combined list p.33; Maple rental sheet');
  });

  it('tells new, changed and unchanged entries apart, and re-running a file plans nothing new', () => {
    const existing = [entry({ season: '2025-26', retail: true, rental: false }), entry({ nodeId: 'spruce', season: '2025-26', retail: true })];
    const { rows, errors } = parseEntriesCsv(
      csv(
        'elevate,Maple,Glade 13 ID,2025-26,listed,retail,yes,,manufacturer,,',
        'elevate,Maple,Spruce 10,2025-26,listed,retail+rental,yes,,manufacturer,,',
        'elevate,Maple,Lumen,2025-26,listed,retail,no,,manufacturer,,',
      ),
      PROGRAMS,
    );
    const plan = planImport(rows, errors, tree, existing, [{ key: 'elevate', latestSeason: '2025-26' }]);
    expect(plan.entries.map((e) => [e.modelLabel, e.change])).toEqual([
      ['Glade 13 ID', 'unchanged'], ['Spruce 10', 'changed'], ['Lumen', 'new'],
    ]);
    expect(plan.mintModels).toEqual([]);
    expect(plan.lapsing).toEqual([]);
  });

  it('lists last season\'s models the file leaves out, per program, as lapsing', () => {
    const existing = [entry({ nodeId: 'glade' }), entry({ nodeId: 'spruce' }), entry({ nodeId: 'lumen' })];
    const { rows, errors } = parseEntriesCsv(csv('elevate,Maple,Glade 13 ID,2025-26,listed,retail,yes,,manufacturer,,'), PROGRAMS);
    const plan = planImport(rows, errors, tree, existing, programs);
    expect(plan.lapsing).toEqual([
      { programKey: 'elevate', fromSeason: '2024-25', toSeason: '2025-26', models: [{ manufacturer: 'Maple', model: 'Lumen' }, { manufacturer: 'Maple', model: 'Spruce 10' }] },
    ]);
  });

  it('plans no lapsing when the file does not move the program to a newer season', () => {
    const existing = [entry({ nodeId: 'glade' }), entry({ nodeId: 'spruce' })];
    const { rows, errors } = parseEntriesCsv(csv('elevate,Maple,Glade 13 ID,2024-25,listed,retail,yes,,manufacturer,,'), PROGRAMS);
    const plan = planImport(rows, errors, tree, existing, programs);
    expect(plan.lapsing).toEqual([]);
  });

  it('keeps a back-season row (Elm lists by season) as its own entry', () => {
    const { rows, errors } = parseEntriesCsv(
      csv(
        'elevate,Maple,Lumen,2015-16,listed,,,,nssra,,',
        'elevate,Maple,Lumen,2025-26,listed,,,,nssra,,',
      ),
      PROGRAMS,
    );
    const plan = planImport(rows, errors, tree, [], programs);
    expect(plan.entries.map((e) => e.season)).toEqual(['2015-16', '2025-26']);
    expect(plan.season).toBe('2025-26');
  });
});

describe('a re-run, and which node a row lands on', () => {
  it('writes nothing when the file has already been imported', () => {
    const existing = [entry({ season: '2025-26' })];
    const { rows, errors } = parseEntriesCsv(csv('elevate,Maple,Glade 13 ID,2025-26,listed,retail,yes,,manufacturer,,'), PROGRAMS);
    const programs = [{ key: 'elevate', latestSeason: '2025-26' }];
    expect(planChangesAnything(planImport(rows, errors, tree, existing, programs), programs)).toBe(false);
    // The same file a season on moves the program, so it writes.
    const behind = [{ key: 'elevate', latestSeason: '2024-25' }];
    expect(planChangesAnything(planImport(rows, errors, tree, existing, behind), behind)).toBe(true);
  });

  it('prefers a live node over a retired one that reads the same, every time', () => {
    const rows = [
      { id: 'b', retiredAt: new Date(), displayOrder: 10 },
      { id: 'c', retiredAt: null, displayOrder: 30 },
      { id: 'a', retiredAt: null, displayOrder: 30 },
    ];
    expect(liveFirst(rows).map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('names the line a row ends on, past blank lines', () => {
    const text = csv('', 'elevate,Maple,Glade,2025-26,listed,retail,yes,,bogus,,');
    const { errors } = parseEntriesCsv(text, PROGRAMS);
    expect(errors[0]).toMatchObject({ line: 3 });
  });
});
