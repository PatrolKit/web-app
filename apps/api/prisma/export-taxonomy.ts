import { PrismaClient, type TaxonomyNode } from '@prisma/client';
import { writeFileSync } from 'fs';
import { join } from 'path';
import type { CategorySpec, AttributeSpec, ValueSpec } from './seed-taxonomy';
import { TAXONOMY_DATA_PATH } from './seed-taxonomy';

/**
 * Writes the shared tree back out as the file the seed reads (Plan 19 §9).
 *
 * The tree is curated through Platform Admin → Item Details, which writes to the
 * database and to nothing else. Without this, everything anyone adds there lives
 * only on whichever server they added it to. Run it, commit the diff, and the
 * curation is in source control like everything else:
 *
 *   pnpm --filter api db:export-taxonomy
 *
 * Only global nodes are exported. An org's own values are that org's, not the
 * shared list's, and promoting one (§8.4) is what moves it into this file's
 * scope.
 *
 * No ids. The same logical node has a different cuid in every database — local
 * and production were seeded independently — so committing ids would make the
 * file portable nowhere. Identity is the label and where it sits, which is what
 * `dedupeKey` already keys on.
 */

const prisma = new PrismaClient();

/** Children of one node, in the order the seed will re-create them. */
function childrenOf(all: TaxonomyNode[], parentId: string | null): TaxonomyNode[] {
  return all
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.displayOrder - b.displayOrder || a.label.localeCompare(b.label));
}

/**
 * A value: a bare string when that is all it is, an object when it carries an
 * icon or opens a branch.
 *
 * Keeping the union is what stops a list of forty model names becoming forty
 * four-line objects, which is the difference between a file someone will read in
 * a pull request and one they will not.
 */
function valueSpecOf(all: TaxonomyNode[], node: TaxonomyNode): ValueSpec {
  const attributes = childrenOf(all, node.id)
    .filter((n) => n.kind === 'ATTRIBUTE')
    .map((a) => attributeSpecOf(all, a));

  if (!node.iconKey && attributes.length === 0 && !node.retiredAt) return node.label;

  return {
    label: node.label,
    ...(node.iconKey ? { icon: node.iconKey } : {}),
    ...(node.retiredAt ? { retired: true } : {}),
    ...(attributes.length ? { attributes } : {}),
  };
}

function attributeSpecOf(all: TaxonomyNode[], node: TaxonomyNode): AttributeSpec {
  const values = childrenOf(all, node.id)
    .filter((n) => n.kind === 'VALUE')
    .map((v) => valueSpecOf(all, v));

  return {
    label: node.label,
    input: node.input === 'NUMBER' ? 'NUMBER' : 'SELECT',
    ...(node.nameSlot !== null ? { nameSlot: node.nameSlot } : {}),
    ...(node.iconKey ? { icon: node.iconKey } : {}),
    ...(node.unit !== null ? { unit: node.unit } : {}),
    ...(node.minValue !== null ? { min: node.minValue } : {}),
    ...(node.maxValue !== null ? { max: node.maxValue } : {}),
    ...(node.step !== null ? { step: node.step } : {}),
    ...(node.allowFreeEntry ? { allowFreeEntry: true } : {}),
    ...(node.retiredAt ? { retired: true } : {}),
    ...(values.length ? { values } : {}),
  };
}

export async function exportTaxonomy(client: PrismaClient): Promise<CategorySpec[]> {
  const all = await client.taxonomyNode.findMany({ where: { orgId: null } });

  return childrenOf(all, null)
    .filter((n) => n.kind === 'CATEGORY')
    .map((c) => ({
      label: c.label,
      ...(c.iconKey ? { icon: c.iconKey } : {}),
      ...(c.retiredAt ? { retired: true } : {}),
      attributes: childrenOf(all, c.id)
        .filter((n) => n.kind === 'ATTRIBUTE')
        .map((a) => attributeSpecOf(all, a)),
    }));
}

async function main() {
  const data = await exportTaxonomy(prisma);
  const nodes = await prisma.taxonomyNode.count({ where: { orgId: null } });

  // Two-space JSON with a trailing newline: what every other committed file in
  // this repo looks like, and what makes a diff readable.
  writeFileSync(TAXONOMY_DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

  console.log(
    `✓ Exported ${data.length} categories (${nodes} shared nodes) to ${
      TAXONOMY_DATA_PATH.split(join('apps', 'api'))[1] ?? TAXONOMY_DATA_PATH
    }`,
  );
  console.log('  Review the diff and commit it.');
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
