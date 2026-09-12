import type { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The shared item-description tree (Plan 19 §9).
 *
 * The data lives in `taxonomy.json` beside this file, not in it. That file is
 * the committed source of truth and is machine-written: curation happens in
 * Platform Admin → Item Details, and `db:export-taxonomy` writes what is in the
 * database back out so the diff can be reviewed and committed.
 *
 * Idempotent on `dedupeKey`: re-seeding adds what is missing and leaves alone
 * what an administrator has since edited, because the alternative is a deploy
 * that silently reverts somebody's curation. The cost of that rule is that the
 * seed can add and it can retire, and it can do nothing about a node it no
 * longer recognises — see `reportUnknown`.
 *
 * The seed uploads no images — an asset would have to live in the repo and reach
 * a bucket that may not exist — so every icon here is a registry key, and a
 * category the registry cannot cover ships without one.
 *
 * ── This runs once per database ────────────────────────────────────────────
 *
 * `taxonomy.json` is a **bootstrap**, not a thing deployed repeatedly. The
 * moment a database has a tree, that database is the authority on it — the
 * shared list is curated in Platform Admin, and nothing in a git branch knows
 * what an administrator decided there yesterday. So a run against a database
 * that already has global nodes does nothing at all.
 *
 * The direction of truth is therefore:
 *
 *   empty database  →  taxonomy.json seeds it, once
 *   after that      →  the database leads, and `db:export-taxonomy` writes it
 *                      back here for source control and for the next new
 *                      environment
 *
 * Which also means **editing this file does not change an existing server**.
 * Add the category in the admin screen and export; do not edit the JSON and
 * deploy, because the deploy will ignore it.
 *
 * Replaying it would not merely be pointless, it would be destructive-adjacent:
 * a node renamed since the last export no longer matches its `dedupeKey`, so
 * the old one gets created again, and for a renamed category or question the
 * whole subtree comes back with it. One renamed category duplicated 27 nodes in
 * testing. Running once is what makes that unreachable in the ordinary case.
 *
 * `SEED_TAXONOMY=force` overrides the guard, for re-bootstrapping a database
 * restored without its tree. It re-opens the rename hazard above, which is why
 * it is a deliberate environment variable and not a default.
 */

/** An answer. A string is a plain value; the object form carries a branch. */
export type ValueSpec =
  | string
  | { label: string; icon?: string; retired?: boolean; attributes?: AttributeSpec[] };

export interface AttributeSpec {
  label: string;
  input: 'SELECT' | 'NUMBER';
  /** Where the answer lands in the derived name. Omitted ⇒ captured, not named. */
  nameSlot?: number;
  icon?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  allowFreeEntry?: boolean;
  retired?: boolean;
  values?: ValueSpec[];
}

export interface CategorySpec {
  label: string;
  icon?: string;
  retired?: boolean;
  attributes: AttributeSpec[];
}

/** Beside this file, so it travels with it in the deploy's prisma/ rsync. */
export const TAXONOMY_DATA_PATH = join(__dirname, 'taxonomy.json');

/**
 * Read rather than imported: `tsconfig.seed.json` does not set
 * `resolveJsonModule`, and the file is data the exporter rewrites rather than
 * something the compiler should inline.
 */
export function loadTaxonomy(): CategorySpec[] {
  return JSON.parse(readFileSync(TAXONOMY_DATA_PATH, 'utf8')) as CategorySpec[];
}

// ─── Writing it ──────────────────────────────────────────────────────────────

/** Mirrors `dedupeKeyFor` in the service. Global rows, so the scope is fixed. */
function dedupeKey(parentId: string | null, label: string): string {
  return `global:${parentId ?? 'root'}:${label.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

/** Every dedupeKey the file accounts for, so the rest can be reported. */
const seen = new Set<string>();
/** How many rows this run actually inserted. Zero is the healthy steady state. */
let inserted = 0;

async function upsertNode(
  prisma: PrismaClient,
  node: {
    kind: 'CATEGORY' | 'ATTRIBUTE' | 'VALUE';
    parentId: string | null;
    label: string;
    iconKey?: string;
    retired?: boolean;
    displayOrder: number;
    input?: 'SELECT' | 'NUMBER';
    nameSlot?: number;
    unit?: string;
    minValue?: number;
    maxValue?: number;
    step?: number;
    allowFreeEntry?: boolean;
  },
): Promise<string> {
  const key = dedupeKey(node.parentId, node.label);
  seen.add(key);

  const existing = await prisma.taxonomyNode.findUnique({
    where: { dedupeKey: key },
    select: { id: true, retiredAt: true },
  });
  if (existing) {
    // Retirement is the one thing a re-seed reconciles. It is reversible, it
    // never destroys anything, and it is how a node exported as retired stays
    // retired on the next server this file reaches.
    const shouldBeRetired = node.retired === true;
    if (shouldBeRetired !== (existing.retiredAt !== null)) {
      await prisma.taxonomyNode.update({
        where: { id: existing.id },
        data: { retiredAt: shouldBeRetired ? new Date() : null },
      });
    }
    return existing.id;
  }

  const created = await prisma.taxonomyNode.create({
    data: {
      id: createId(),
      kind: node.kind,
      orgId: null,
      parentId: node.parentId,
      label: node.label,
      iconKey: node.iconKey ?? null,
      displayOrder: node.displayOrder,
      status: 'APPROVED',
      approvedAt: new Date(),
      input: node.input ?? null,
      nameSlot: node.nameSlot ?? null,
      unit: node.unit ?? null,
      minValue: node.minValue ?? null,
      maxValue: node.maxValue ?? null,
      step: node.step ?? null,
      allowFreeEntry: node.allowFreeEntry ?? false,
      retiredAt: node.retired ? new Date() : null,
      dedupeKey: key,
    },
    select: { id: true },
  });
  inserted += 1;
  return created.id;
}

async function seedAttributes(
  prisma: PrismaClient,
  parentId: string,
  specs: AttributeSpec[],
): Promise<number> {
  let written = 0;
  let order = 10;
  for (const spec of specs) {
    const attributeId = await upsertNode(prisma, {
      kind: 'ATTRIBUTE',
      parentId,
      label: spec.label,
      iconKey: spec.icon,
      displayOrder: order,
      input: spec.input,
      nameSlot: spec.nameSlot,
      unit: spec.unit,
      minValue: spec.min,
      maxValue: spec.max,
      step: spec.step,
      allowFreeEntry: spec.allowFreeEntry,
      retired: spec.retired,
    });
    written += 1;
    order += 10;

    let valueOrder = 10;
    for (const value of spec.values ?? []) {
      const label = typeof value === 'string' ? value : value.label;
      const valueId = await upsertNode(prisma, {
        kind: 'VALUE',
        parentId: attributeId,
        label,
        iconKey: typeof value === 'string' ? undefined : value.icon,
        retired: typeof value === 'string' ? undefined : value.retired,
        displayOrder: valueOrder,
      });
      written += 1;
      valueOrder += 10;

      if (typeof value !== 'string' && value.attributes?.length) {
        written += await seedAttributes(prisma, valueId, value.attributes);
      }
    }
  }
  return written;
}

/**
 * Shared nodes this file said nothing about.
 *
 * The seed adds and retires; it never deletes, so a node renamed or removed
 * through the admin screen since the last export simply stops being mentioned
 * here and carries on existing. That is the safe behaviour and it is also
 * invisible, which is why it is printed: a deploy that quietly leaves a stale
 * "Volkl" beside a renamed "Völkl" is how the shared list rots.
 *
 * The fix is always the same — run `db:export-taxonomy` against that server and
 * commit the result.
 */
async function reportUnknown(prisma: PrismaClient): Promise<void> {
  const orphans = await prisma.taxonomyNode.findMany({
    where: { orgId: null, dedupeKey: { notIn: [...seen] } },
    select: { label: true, dedupeKey: true },
    take: 20,
  });
  if (orphans.length === 0) return;

  const total = await prisma.taxonomyNode.count({
    where: { orgId: null, dedupeKey: { notIn: [...seen] } },
  });
  console.warn(`⚠ ${total} shared node(s) are in the database but not in taxonomy.json:`);
  for (const o of orphans) console.warn(`    ${o.label}  (${o.dedupeKey})`);
  if (total > orphans.length) console.warn(`    …and ${total - orphans.length} more`);
  console.warn('  They were left alone — this seed never deletes.');
  console.warn('  Run `pnpm --filter api db:export-taxonomy` on this server and commit the result.');
  if (inserted > 0) {
    // A rename is the case that lands here loudly: every descendant of the
    // renamed node is orphaned with it and re-created whole, so one edit can
    // duplicate a whole subtree.
    console.warn(
      `  ${inserted} node(s) were added this run — if that is a surprise, something in the file was renamed here and the duplicate needs retiring.`,
    );
  }
}

export async function seedTaxonomy(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.taxonomyNode.count({ where: { orgId: null } });
  const forced = process.env.SEED_TAXONOMY === 'force';

  if (existing > 0 && !forced) {
    console.log(
      `• Item taxonomy already present (${existing} shared nodes) — left alone.` +
        ' This database leads; run `db:export-taxonomy` to capture changes made here.',
    );
    return;
  }
  if (existing > 0 && forced) {
    console.warn('⚠ SEED_TAXONOMY=force: replaying taxonomy.json over an existing tree.');
  }

  seen.clear();
  inserted = 0;
  let written = 0;
  let order = 10;

  for (const category of loadTaxonomy()) {
    const categoryId = await upsertNode(prisma, {
      kind: 'CATEGORY',
      parentId: null,
      label: category.label,
      iconKey: category.icon,
      retired: category.retired,
      displayOrder: order,
    });
    written += 1;
    order += 10;
    written += await seedAttributes(prisma, categoryId, category.attributes);
  }

  const total = await prisma.taxonomyNode.count({ where: { orgId: null } });
  console.log(
    `✓ Item taxonomy seeded (${written} checked, ${inserted} added, ${total} shared nodes)`,
  );
  await reportUnknown(prisma);
}
