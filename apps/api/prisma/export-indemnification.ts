import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Writes a database's indemnified-binding lists back out (Plan 44), one
 * folder per season, in the form the import reads:
 *
 *   pnpm --filter api db:export-indemnification -- "/path/to/backup"
 *
 *   <folder>/<season>/entries.csv    every entry for that season
 *   <folder>/<season>/programs.json  the programs' names and notes
 *
 * Which bindings are indemnified is licensed, so this is for a private copy:
 * never commit the output to a public repository. Re-importing it finds the
 * same model nodes, so it changes nothing.
 *
 * Self-contained (Prisma only), so it runs on a server that has the built
 * app but not the TypeScript sources.
 */

export interface ExportRow {
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

const COLUMNS = ['program', 'manufacturer', 'model', 'season', 'status', 'lines', 'current_line', 'non_iso', 'source', 'source_ref', 'note'];

/** A CSV field: quoted when it has a comma, a quote or a line break. */
function field(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** The rows as the import's CSV (Plan 44 D7), sorted by program, maker and model. */
export function entriesCsv(rows: ExportRow[]): string {
  const sorted = [...rows].sort((a, b) =>
    a.program.localeCompare(b.program) || a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model));
  const lines = sorted.map((r) => [
    r.program,
    r.manufacturer,
    r.model,
    r.season,
    r.status === 'FINAL_SEASON' ? 'final_season' : 'listed',
    [r.retail ? 'retail' : '', r.rental ? 'rental' : '', r.demo ? 'demo' : ''].filter(Boolean).join('+'),
    r.currentLine === null ? '' : r.currentLine ? 'yes' : 'no',
    r.nonIso ? 'yes' : '',
    r.source === 'MANUFACTURER' ? 'manufacturer' : 'nssra',
    r.sourceRef ?? '',
    r.note ?? '',
  ].map(field).join(','));
  return [COLUMNS.join(','), ...lines].join('\r\n') + '\r\n';
}

async function main() {
  const arg = process.argv.slice(2).find((a) => a !== '--');
  if (!arg) {
    console.error('Usage: db:export-indemnification -- <folder to write the seasons into>');
    process.exit(1);
  }
  const out = resolve(arg);
  const prisma = new PrismaClient();
  try {
    const entries = await prisma.bindingIndemnification.findMany();
    const nodeIds = [...new Set(entries.map((e) => e.nodeId))];
    // Model value → Model question → maker value: two hops up, in two reads.
    const models = await prisma.taxonomyNode.findMany({ where: { id: { in: nodeIds } }, select: { id: true, label: true, parentId: true } });
    const questions = await prisma.taxonomyNode.findMany({
      where: { id: { in: [...new Set(models.map((m) => m.parentId!).filter(Boolean))] } },
      select: { id: true, parentId: true },
    });
    const makers = await prisma.taxonomyNode.findMany({
      where: { id: { in: [...new Set(questions.map((q) => q.parentId!).filter(Boolean))] } },
      select: { id: true, label: true },
    });
    const modelById = new Map(models.map((m) => [m.id, m]));
    const makerOfQuestion = new Map(questions.map((q) => [q.id, makers.find((m) => m.id === q.parentId)?.label ?? '']));

    const bySeason = new Map<string, ExportRow[]>();
    for (const e of entries) {
      const model = modelById.get(e.nodeId);
      if (!model) continue;
      const row: ExportRow = {
        program: e.programKey, manufacturer: makerOfQuestion.get(model.parentId ?? '') ?? '', model: model.label, season: e.season,
        status: e.status, retail: e.retail, rental: e.rental, demo: e.demo, currentLine: e.currentLine, nonIso: e.nonIso,
        source: e.source, sourceRef: e.sourceRef, note: e.note,
      };
      bySeason.set(e.season, [...(bySeason.get(e.season) ?? []), row]);
    }
    const programs = (await prisma.bindingIndemnificationProgram.findMany({ orderBy: { key: 'asc' } }))
      .map((p) => ({ key: p.key, name: p.name, notes: p.notes }));

    for (const [season, rows] of [...bySeason].sort()) {
      const dir = join(out, season);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'entries.csv'), entriesCsv(rows), 'utf8');
      writeFileSync(join(dir, 'programs.json'), `${JSON.stringify(programs, null, 2)}\n`, 'utf8');
      console.log(`✓ ${season}: ${rows.length} entries`);
    }
    if (bySeason.size === 0) console.log('No entries to export.');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
