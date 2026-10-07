import { PrismaClient } from '@prisma/client';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  applyImport,
  liveFirst,
  planChangesAnything,
  parseEntriesCsv,
  planImport,
  type ExistingEntry,
  type TreeSnapshot,
} from '../src/ski-swap/indemnification/indemnification-import';
import { BINDING_MANUFACTURER_PATH, BINDING_MODEL_LABEL, findByPath } from '../src/ski-swap/taxonomy/binding-tree';

/**
 * Loads one season's indemnified-bindings lists into a database from the
 * committed files (Plan 44 D7):
 *
 *   pnpm --filter api db:import-indemnification -- 2025-26
 *
 * Reads `prisma/indemnification/<season>/entries.csv` and `programs.json`
 * beside it, and runs the same planner and applier the admin import runs. For
 * a fresh database, or to re-run a season; production takes the file through
 * Platform Admin → Bindings, where the dry run shows what would lapse first.
 */

const prisma = new PrismaClient();

async function snapshot(): Promise<TreeSnapshot> {
  const nodes = await prisma.taxonomyNode.findMany({
    where: { orgId: null },
    select: { id: true, parentId: true, label: true, kind: true, orgId: true, retiredAt: true, displayOrder: true },
  });
  const attr = findByPath(nodes, BINDING_MANUFACTURER_PATH);
  if (!attr) throw new Error('The tree has no Bindings › Type › Skis › Manufacturer. Seed the taxonomy first.');
  const makers = nodes.filter((n) => n.parentId === attr.id && n.kind === 'VALUE');
  return {
    manufacturerAttrId: attr.id,
    manufacturers: makers.map((m) => {
      const modelAttr = nodes.find((n) => n.parentId === m.id && n.kind === 'ATTRIBUTE' && n.label.toLowerCase() === BINDING_MODEL_LABEL.toLowerCase()) ?? null;
      return {
        id: m.id,
        label: m.label,
        modelAttrId: modelAttr?.id ?? null,
        models: modelAttr ? liveFirst(nodes.filter((n) => n.parentId === modelAttr.id && n.kind === 'VALUE')).map((n) => ({ id: n.id, label: n.label })) : [],
      };
    }),
  };
}

async function main() {
  // pnpm hands the `--` through, so the season is the first argument that looks like one.
  const season = process.argv.slice(2).find((a) => /^\d{4}-\d{2}$/.test(a));
  if (!season) {
    console.error('Usage: db:import-indemnification -- <season>, like 2025-26');
    process.exit(1);
  }
  const dir = join(__dirname, 'indemnification', season);
  const entriesPath = join(dir, 'entries.csv');
  const programsPath = join(dir, 'programs.json');
  if (!existsSync(entriesPath)) throw new Error(`No ${entriesPath}`);

  // Program names and notes travel with the season's file. Notes an admin
  // has already written in Platform Admin are theirs, and stay.
  if (existsSync(programsPath)) {
    const programs = JSON.parse(readFileSync(programsPath, 'utf8')) as { key: string; name: string; notes: string }[];
    for (const p of programs) {
      const held = await prisma.bindingIndemnificationProgram.findUnique({ where: { key: p.key }, select: { notes: true } });
      await prisma.bindingIndemnificationProgram.upsert({
        where: { key: p.key },
        create: { key: p.key, name: p.name, notes: p.notes ?? '' },
        update: { name: p.name, ...(held?.notes.trim() ? {} : { notes: p.notes ?? '' }) },
      });
    }
    console.log(`✓ ${programs.length} programs`);
  }

  const programRows = await prisma.bindingIndemnificationProgram.findMany({ select: { key: true, latestSeason: true } });
  const { rows, errors } = parseEntriesCsv(readFileSync(entriesPath, 'utf8'), new Set(programRows.map((p) => p.key)));
  const tree = await snapshot();
  const existing = (await prisma.bindingIndemnification.findMany()) as ExistingEntry[];
  const plan = planImport(rows, errors, tree, existing, programRows);
  if (plan.errors.length) {
    for (const e of plan.errors) console.error(`  line ${e.line}: ${e.message}`);
    throw new Error(`${plan.errors.length} row error(s); nothing imported`);
  }
  console.log(
    `• ${plan.rows} rows → mint ${plan.mintManufacturers.length} makers, ${plan.mintModels.length} models; ` +
      `${plan.entries.filter((e) => e.change === 'new').length} new, ${plan.entries.filter((e) => e.change === 'changed').length} changed, ` +
      `${plan.entries.filter((e) => e.change === 'unchanged').length} unchanged entries`,
  );
  for (const l of plan.lapsing) console.log(`  ${l.programKey}: ${l.models.length} model(s) lapse from ${l.fromSeason} to ${l.toSeason}`);

  if (!planChangesAnything(plan, programRows)) {
    console.log(`✓ ${season} is already in: nothing to write`);
    return;
  }
  const result = await prisma.$transaction(
    async (tx) => {
      const applied = await applyImport(tx, plan, tree, { actorId: null, fileName: `prisma/indemnification/${season}/entries.csv` });
      // Only a changed tree makes every org's iPads and browsers refetch it.
      if (applied.treeChanged) await tx.skiSwapSettings.updateMany({ data: { taxonomyVersion: { increment: 1 } } });
      return applied;
    },
    { timeout: 180_000, maxWait: 15_000 },
  );
  console.log(`✓ Imported ${season}: ${result.entriesWritten} entries written (import ${result.importId})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
