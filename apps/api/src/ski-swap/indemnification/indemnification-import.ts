import { parse as parseCsv } from 'csv-parse/sync';
import type { Prisma } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { dedupeKeyFor, normalizeLabel } from '../taxonomy/dedupe';
import { BINDING_MODEL_LABEL, BINDING_MODEL_NAME_SLOT } from '../taxonomy/binding-tree';
import { SEASON_PATTERN } from '../../contracts/indemnification.contracts';

/**
 * The seasonal import (Plan 44 D7, D8), in three pure-ish parts:
 *
 * - `parseEntriesCsv`: the CSV into rows, or the lines it couldn't read;
 * - `planImport`: rows against the tree and the entries already held, into
 *   what a commit would mint, write and leave lapsing — nothing written;
 * - `applyImport`: the plan, through a Prisma transaction client.
 *
 * Nothing here imports Nest, so a seed script can run the same code against a
 * fresh database as the admin route runs against production.
 */

export interface EntryRow {
  line: number;
  program: string;
  manufacturer: string;
  model: string;
  season: string;
  status: 'LISTED' | 'FINAL_SEASON';
  retail: boolean;
  rental: boolean;
  demo: boolean;
  currentLine: boolean | null;
  nonIso: boolean;
  source: 'NSSRA' | 'MANUFACTURER';
  sourceRef: string | null;
  note: string | null;
}

export interface RowError {
  line: number;
  message: string;
}

export const ENTRY_COLUMNS = [
  'program', 'manufacturer', 'model', 'season', 'status', 'lines',
  'current_line', 'non_iso', 'source', 'source_ref', 'note',
] as const;

const truthy = new Set(['yes', 'y', 'true', '1', 'x']);
const falsy = new Set(['no', 'n', 'false', '0']);

function readBool(raw: string, line: number, column: string, errors: RowError[]): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === '') return null;
  if (truthy.has(v)) return true;
  if (falsy.has(v)) return false;
  errors.push({ line, message: `${column}: "${raw}" isn't yes or no` });
  return null;
}

/** The CSV into rows. Headers in any case; unknown columns ignored. */
export function parseEntriesCsv(text: string, programs: Set<string>): { rows: EntryRow[]; errors: RowError[] } {
  const errors: RowError[] = [];
  let records: Record<string, string>[];
  try {
    records = parseCsv(text, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_')),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      info: true,
    }).map((rec: { record: Record<string, string>; info: { lines: number } }) => ({ ...rec.record, __line: String(rec.info.lines) }));
  } catch (err) {
    return { rows: [], errors: [{ line: 0, message: `Couldn't read the file: ${(err as Error).message}` }] };
  }

  const rows: EntryRow[] = [];
  records.forEach((r, i) => {
    const line = Number(r.__line) || i + 2; // where the row ends in the file
    const program = (r.program ?? '').trim().toLowerCase();
    const manufacturer = (r.manufacturer ?? '').trim().replace(/\s+/g, ' ');
    const model = (r.model ?? '').trim().replace(/\s+/g, ' ');
    const season = (r.season ?? '').trim();
    const statusRaw = (r.status ?? 'listed').trim().toLowerCase();
    const sourceRaw = (r.source ?? '').trim().toLowerCase();
    const before = errors.length;

    if (!program) errors.push({ line, message: 'program is blank' });
    else if (!programs.has(program)) errors.push({ line, message: `program "${program}" isn't one of ${[...programs].join(', ')}` });
    if (!manufacturer) errors.push({ line, message: 'manufacturer is blank' });
    if (!model) errors.push({ line, message: 'model is blank' });
    if (!SEASON_PATTERN.test(season)) errors.push({ line, message: `season "${season}" isn't like 2025-26` });
    else {
      const start = Number(season.slice(0, 4));
      const end = Number(season.slice(5));
      if ((start + 1) % 100 !== end) errors.push({ line, message: `season "${season}" doesn't run one year` });
    }
    if (statusRaw !== 'listed' && statusRaw !== 'final_season') {
      errors.push({ line, message: `status "${statusRaw}" isn't listed or final_season` });
    }
    if (sourceRaw !== 'nssra' && sourceRaw !== 'manufacturer') {
      errors.push({ line, message: `source "${sourceRaw}" isn't nssra or manufacturer` });
    }
    const lines = (r.lines ?? '').split(/[+|,;/ ]+/).map((l) => l.trim().toLowerCase()).filter(Boolean);
    for (const l of lines) {
      if (l !== 'retail' && l !== 'rental' && l !== 'demo') errors.push({ line, message: `lines: "${l}" isn't retail, rental or demo` });
    }
    const currentLine = readBool(r.current_line ?? '', line, 'current_line', errors);
    const nonIso = readBool(r.non_iso ?? '', line, 'non_iso', errors) ?? false;
    if (errors.length > before) return;

    rows.push({
      line,
      program,
      manufacturer,
      model,
      season,
      status: statusRaw === 'final_season' ? 'FINAL_SEASON' : 'LISTED',
      retail: lines.includes('retail'),
      rental: lines.includes('rental'),
      demo: lines.includes('demo'),
      currentLine,
      nonIso,
      source: sourceRaw === 'manufacturer' ? 'MANUFACTURER' : 'NSSRA',
      sourceRef: (r.source_ref ?? '').trim() || null,
      note: (r.note ?? '').trim() || null,
    });
  });
  return { rows, errors };
}

/**
 * Spelling, not meaning, as Plan 42 matches: case, accents, spacing and
 * apostrophes don't count; nor does a superscript ("ATTACK²" is "attack2") or
 * punctuation ("S/Lab" is "slab"). "Griffon 13" still doesn't find
 * "Griffon 13 ID".
 */
export function normalizeModel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A query against a model, by tokens: every query token starts some token of "maker model". */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = normalizeModel(query).split(' ').filter(Boolean);
  if (q.length === 0) return true;
  const h = normalizeModel(haystack).split(' ').filter(Boolean);
  return q.every((t) => h.some((w) => w.startsWith(t)));
}

// ─── Planning ────────────────────────────────────────────────────────────────

export interface TreeManufacturer {
  id: string;
  label: string;
  /** Its Model question, if it has one yet. */
  modelAttrId: string | null;
  models: { id: string; label: string }[];
}

export interface TreeSnapshot {
  /** Bindings › Type › Skis › Manufacturer. */
  manufacturerAttrId: string;
  manufacturers: TreeManufacturer[];
}

export interface ExistingEntry {
  nodeId: string;
  programKey: string;
  season: string;
  status: 'LISTED' | 'FINAL_SEASON';
  retail: boolean;
  rental: boolean;
  demo: boolean;
  currentLine: boolean | null;
  nonIso: boolean;
  source: 'NSSRA' | 'MANUFACTURER';
  sourceRef: string | null;
  note: string | null;
}

export interface PlannedEntry {
  manufacturerKey: string;
  manufacturerLabel: string;
  modelKey: string;
  modelLabel: string;
  /** The model's node, when it exists already. */
  nodeId: string | null;
  programKey: string;
  season: string;
  status: 'LISTED' | 'FINAL_SEASON';
  retail: boolean;
  rental: boolean;
  demo: boolean;
  currentLine: boolean | null;
  nonIso: boolean;
  source: 'NSSRA' | 'MANUFACTURER';
  sourceRef: string | null;
  note: string | null;
  change: 'new' | 'changed' | 'unchanged';
}

export interface ImportPlan {
  /** The newest season in the file. */
  season: string | null;
  rows: number;
  errors: RowError[];
  mintManufacturers: { key: string; label: string }[];
  /** Manufacturers (existing or minted) that need a Model question. */
  mintModelAttributes: string[];
  mintModels: { manufacturerKey: string; manufacturerLabel: string; key: string; label: string }[];
  entries: PlannedEntry[];
  lapsing: { programKey: string; fromSeason: string; toSeason: string; models: { manufacturer: string; model: string }[] }[];
  /** Each program in the file and the season it moves to. */
  programSeasons: { key: string; season: string }[];
}

const mfrKey = (label: string) => normalizeLabel(label.normalize('NFD').replace(/[̀-ͯ]/g, ''));

/** Two rows for one (maker, model, season): one entry, the more generous reading. */
function mergeRows(a: PlannedEntry, b: EntryRow): PlannedEntry {
  return {
    ...a,
    status: a.status === 'FINAL_SEASON' || b.status === 'FINAL_SEASON' ? 'FINAL_SEASON' : 'LISTED',
    retail: a.retail || b.retail,
    rental: a.rental || b.rental,
    demo: a.demo || b.demo,
    currentLine: a.currentLine === true || b.currentLine === true ? true : (a.currentLine ?? b.currentLine),
    nonIso: a.nonIso || b.nonIso,
    // A maker's own sheet outranks the combined list (D6).
    source: a.source === 'MANUFACTURER' || b.source === 'MANUFACTURER' ? 'MANUFACTURER' : 'NSSRA',
    sourceRef: a.sourceRef && b.sourceRef && a.sourceRef !== b.sourceRef ? `${a.sourceRef}; ${b.sourceRef}` : a.sourceRef ?? b.sourceRef,
    note: a.note && b.note && a.note !== b.note ? `${a.note} ${b.note}` : a.note ?? b.note,
  };
}

function sameEntry(e: ExistingEntry, p: PlannedEntry): boolean {
  return (
    e.programKey === p.programKey && e.status === p.status && e.retail === p.retail && e.rental === p.rental &&
    e.demo === p.demo && e.currentLine === p.currentLine && e.nonIso === p.nonIso && e.source === p.source &&
    (e.sourceRef ?? null) === (p.sourceRef ?? null) && (e.note ?? null) === (p.note ?? null)
  );
}

export function planImport(
  rows: EntryRow[],
  errors: RowError[],
  tree: TreeSnapshot,
  existing: ExistingEntry[],
  programs: { key: string; latestSeason: string | null }[],
): ImportPlan {
  const byMfrKey = new Map(tree.manufacturers.map((m) => [mfrKey(m.label), m]));
  const mintManufacturers = new Map<string, { key: string; label: string }>();
  const mintModelAttributes = new Set<string>();
  const mintModels = new Map<string, ImportPlan['mintModels'][number]>();
  const planned = new Map<string, PlannedEntry>();

  for (const r of rows) {
    const mk = mfrKey(r.manufacturer);
    const maker = byMfrKey.get(mk);
    if (!maker && !mintManufacturers.has(mk)) mintManufacturers.set(mk, { key: mk, label: r.manufacturer });
    if (maker && !maker.modelAttrId) mintModelAttributes.add(mk);
    const modelKey = normalizeModel(r.model);
    const node = maker?.models.find((m) => normalizeModel(m.label) === modelKey) ?? null;
    if (!node && !mintModels.has(`${mk}\u0000${modelKey}`)) {
      mintModels.set(`${mk}\u0000${modelKey}`, { manufacturerKey: mk, manufacturerLabel: maker?.label ?? r.manufacturer, key: modelKey, label: r.model });
    }
    const key = `${mk}\u0000${modelKey}\u0000${r.season}`;
    const prior = planned.get(key);
    const fresh: PlannedEntry = {
      manufacturerKey: mk,
      manufacturerLabel: maker?.label ?? r.manufacturer,
      modelKey,
      modelLabel: node?.label ?? r.model,
      nodeId: node?.id ?? null,
      programKey: r.program,
      season: r.season,
      status: r.status,
      retail: r.retail,
      rental: r.rental,
      demo: r.demo,
      currentLine: r.currentLine,
      nonIso: r.nonIso,
      source: r.source,
      sourceRef: r.sourceRef,
      note: r.note,
      change: 'new',
    };
    planned.set(key, prior ? mergeRows(prior, r) : fresh);
  }

  // What each would change, against what is held.
  const held = new Map(existing.map((e) => [`${e.nodeId}\u0000${e.season}`, e]));
  for (const p of planned.values()) {
    if (!p.nodeId) continue;
    const e = held.get(`${p.nodeId}\u0000${p.season}`);
    p.change = !e ? 'new' : sameEntry(e, p) ? 'unchanged' : 'changed';
  }

  // Each program moves to the newest season the file gives it. Last season's
  // models that the file doesn't name are about to read lapsed (D4, D8).
  const programSeasons = new Map<string, string>();
  for (const p of planned.values()) {
    const cur = programSeasons.get(p.programKey);
    if (!cur || p.season > cur) programSeasons.set(p.programKey, p.season);
  }
  const lapsing: ImportPlan['lapsing'] = [];
  const nodeLabel = new Map<string, { manufacturer: string; model: string }>();
  for (const m of tree.manufacturers) for (const v of m.models) nodeLabel.set(v.id, { manufacturer: m.label, model: v.label });
  for (const [key, toSeason] of programSeasons) {
    const program = programs.find((p) => p.key === key);
    const fromSeason = program?.latestSeason ?? null;
    if (!fromSeason || fromSeason >= toSeason) continue;
    const named = new Set([...planned.values()].filter((p) => p.programKey === key && p.season === toSeason && p.nodeId).map((p) => p.nodeId!));
    const models = existing
      .filter((e) => e.programKey === key && e.season === fromSeason && !named.has(e.nodeId))
      .map((e) => nodeLabel.get(e.nodeId) ?? { manufacturer: '?', model: e.nodeId })
      .sort((a, b) => a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model));
    if (models.length) lapsing.push({ programKey: key, fromSeason, toSeason, models });
  }

  const seasons = [...planned.values()].map((p) => p.season).sort();
  return {
    season: seasons.length ? seasons[seasons.length - 1] : null,
    rows: rows.length,
    errors,
    mintManufacturers: [...mintManufacturers.values()].sort((a, b) => a.label.localeCompare(b.label)),
    mintModelAttributes: [...mintModelAttributes],
    mintModels: [...mintModels.values()].sort((a, b) => a.manufacturerLabel.localeCompare(b.manufacturerLabel) || a.label.localeCompare(b.label)),
    entries: [...planned.values()],
    lapsing,
    programSeasons: [...programSeasons].map(([key, season]) => ({ key, season })),
  };
}

// ─── Applying ────────────────────────────────────────────────────────────────

export interface ApplyContext {
  actorId: string | null;
  fileName: string | null;
}

export interface ApplyResult {
  importId: string;
  mintedManufacturers: number;
  mintedModels: number;
  entriesWritten: number;
  /** Something every org's tree shows was added or changed: the version bumps. */
  treeChanged: boolean;
}

/**
 * Writes a plan. One transaction, the caller's: minting in the taxonomy, the
 * import record, the entries, each program's `latestSeason`.
 *
 * Mints global nodes the way `TaxonomyService.createNode` does — same dedupe
 * key, approved, ordered after what's there — without the service, so a seed
 * can run it.
 */
export async function applyImport(
  tx: Prisma.TransactionClient,
  plan: ImportPlan,
  tree: TreeSnapshot,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  if (plan.errors.length) throw new Error('A plan with errors cannot be applied');
  const now = new Date();
  const makerIdByKey = new Map<string, string>();
  const modelAttrByMakerKey = new Map<string, string>();
  const modelIdByKey = new Map<string, string>();
  for (const m of tree.manufacturers) {
    makerIdByKey.set(mfrKey(m.label), m.id);
    if (m.modelAttrId) modelAttrByMakerKey.set(mfrKey(m.label), m.modelAttrId);
    for (const v of m.models) modelIdByKey.set(`${mfrKey(m.label)}\u0000${normalizeModel(v.label)}`, v.id);
  }

  let order = Math.max(0, ...(await tx.taxonomyNode.findMany({
    where: { parentId: tree.manufacturerAttrId }, select: { displayOrder: true },
  })).map((n) => n.displayOrder));
  for (const m of plan.mintManufacturers) {
    order += 10;
    const created = await tx.taxonomyNode.create({
      data: {
        id: createId(), kind: 'VALUE', orgId: null, parentId: tree.manufacturerAttrId, label: m.label,
        displayOrder: order, status: 'APPROVED', approvedBy: ctx.actorId, approvedAt: now, createdBy: ctx.actorId,
        dedupeKey: dedupeKeyFor(null, tree.manufacturerAttrId, m.label),
      },
      select: { id: true },
    });
    makerIdByKey.set(m.key, created.id);
  }

  const needAttr = new Set([...plan.mintModelAttributes, ...plan.mintManufacturers.map((m) => m.key)]);
  for (const key of needAttr) {
    const makerId = makerIdByKey.get(key)!;
    const created = await tx.taxonomyNode.create({
      data: {
        id: createId(), kind: 'ATTRIBUTE', orgId: null, parentId: makerId, label: BINDING_MODEL_LABEL,
        input: 'SELECT', nameSlot: BINDING_MODEL_NAME_SLOT, allowFreeEntry: true, displayOrder: 10,
        status: 'APPROVED', approvedBy: ctx.actorId, approvedAt: now, createdBy: ctx.actorId,
        dedupeKey: dedupeKeyFor(null, makerId, BINDING_MODEL_LABEL),
      },
      select: { id: true },
    });
    modelAttrByMakerKey.set(key, created.id);
  }

  const nextOrder = new Map<string, number>();
  for (const m of plan.mintModels) {
    const attrId = modelAttrByMakerKey.get(m.manufacturerKey)!;
    if (!nextOrder.has(attrId)) {
      const last = await tx.taxonomyNode.findFirst({ where: { parentId: attrId }, orderBy: { displayOrder: 'desc' }, select: { displayOrder: true } });
      nextOrder.set(attrId, last?.displayOrder ?? 0);
    }
    const o = nextOrder.get(attrId)! + 10;
    nextOrder.set(attrId, o);
    const created = await tx.taxonomyNode.create({
      data: {
        id: createId(), kind: 'VALUE', orgId: null, parentId: attrId, label: m.label, displayOrder: o,
        status: 'APPROVED', approvedBy: ctx.actorId, approvedAt: now, createdBy: ctx.actorId,
        dedupeKey: dedupeKeyFor(null, attrId, m.label),
      },
      select: { id: true },
    });
    modelIdByKey.set(`${m.manufacturerKey}\u0000${m.key}`, created.id);
  }

  const record = await tx.bindingIndemnificationImport.create({
    data: {
      season: plan.season ?? '',
      fileName: ctx.fileName,
      createdById: ctx.actorId,
      counts: {
        rows: plan.rows,
        mintManufacturers: plan.mintManufacturers.length,
        mintModels: plan.mintModels.length,
        new: plan.entries.filter((e) => e.change === 'new').length,
        changed: plan.entries.filter((e) => e.change === 'changed').length,
        unchanged: plan.entries.filter((e) => e.change === 'unchanged').length,
        lapsing: plan.lapsing.reduce((n, l) => n + l.models.length, 0),
      },
    },
    select: { id: true },
  });

  let written = 0;
  for (const e of plan.entries) {
    if (e.change === 'unchanged') continue;
    const nodeId = e.nodeId ?? modelIdByKey.get(`${e.manufacturerKey}\u0000${e.modelKey}`);
    if (!nodeId) throw new Error(`No node for ${e.manufacturerLabel} ${e.modelLabel}`);
    const data = {
      programKey: e.programKey, status: e.status, retail: e.retail, rental: e.rental, demo: e.demo,
      currentLine: e.currentLine, nonIso: e.nonIso, source: e.source, sourceRef: e.sourceRef, note: e.note,
      importId: record.id,
    };
    await tx.bindingIndemnification.upsert({
      where: { nodeId_season: { nodeId, season: e.season } },
      create: { nodeId, season: e.season, ...data },
      update: data,
    });
    written += 1;
  }

  for (const { key, season } of plan.programSeasons) {
    const program = await tx.bindingIndemnificationProgram.findUnique({ where: { key }, select: { latestSeason: true } });
    if (!program?.latestSeason || program.latestSeason < season) {
      await tx.bindingIndemnificationProgram.update({ where: { key }, data: { latestSeason: season } });
    }
  }

  // Unlisted makers stay describable: the question takes typed answers (D1).
  // Last, and only when it's off: the row is every binding maker's parent, so
  // holding its lock for the whole import would stall check-in saves that
  // type a new maker.
  const freeEntry = await tx.taxonomyNode.updateMany({
    where: { id: tree.manufacturerAttrId, allowFreeEntry: false },
    data: { allowFreeEntry: true },
  });

  return {
    importId: record.id,
    mintedManufacturers: plan.mintManufacturers.length,
    mintedModels: plan.mintModels.length,
    entriesWritten: written,
    treeChanged: plan.mintManufacturers.length + needAttr.size + plan.mintModels.length + freeEntry.count > 0,
  };
}

/**
 * Whether a plan writes anything at all. Re-running last August's file is a
 * no-op: no import record, and nobody's tree is refetched.
 */
export function planChangesAnything(plan: ImportPlan, programs: { key: string; latestSeason: string | null }[]): boolean {
  const latest = new Map(programs.map((p) => [p.key, p.latestSeason]));
  return plan.mintManufacturers.length > 0 || plan.mintModelAttributes.length > 0 || plan.mintModels.length > 0
    || plan.entries.some((e) => e.change !== 'unchanged')
    || plan.programSeasons.some(({ key, season }) => { const at = latest.get(key); return !at || at < season; });
}

/**
 * A snapshot's models, live ones first, then in list order: where two nodes
 * read the same once normalized ("S/Lab 10", "S-Lab 10"), or one was retired,
 * the planner's first match is the live one, every time.
 */
export function liveFirst<T extends { id: string; retiredAt: Date | null; displayOrder: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    Number(a.retiredAt !== null) - Number(b.retiredAt !== null) || a.displayOrder - b.displayOrder || a.id.localeCompare(b.id));
}
