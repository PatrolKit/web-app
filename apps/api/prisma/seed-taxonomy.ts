import type { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';

/**
 * The shared item-description tree (Plan 19 §9).
 *
 * Data rather than clicks, so the global tree is reproducible and reviewable in
 * a diff. Idempotent on `dedupeKey`: re-seeding adds what is missing and leaves
 * alone what an administrator has since edited, because the alternative is a
 * deploy that silently reverts somebody's curation.
 *
 * The seed uploads no images — an asset would have to live in the repo and reach
 * a bucket that may not exist — so every icon here is a registry key, and a
 * category the registry cannot cover ships without one.
 */

/** An answer. A string is a plain value; the object form carries a branch. */
type ValueSpec = string | { label: string; icon?: string; attributes?: AttributeSpec[] };

interface AttributeSpec {
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
  values?: ValueSpec[];
}

interface CategorySpec {
  label: string;
  icon?: string;
  attributes: AttributeSpec[];
}

// ─── Shared value lists ──────────────────────────────────────────────────────
//
// Spelled out per attribute rather than shared between them. An attribute's
// values are its children, and there is no value reuse across attributes — a
// real cost in verbosity and the right trade, because a shared table would mean
// a color edit for jackets silently changing skis.

const COLORS = [
  'Black', 'White', 'Grey', 'Red', 'Blue', 'Navy', 'Green', 'Yellow',
  'Orange', 'Purple', 'Pink', 'Brown', 'Teal', 'Multicolour',
];

const APPAREL_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const KIDS_SIZES = ['2', '3', '4', '5', '6', '8', '10', '12', '14', '16'];
const GENDERS = ['Mens', 'Womens', 'Kids', 'Unisex'];

/** Ski and board brands, with model lists thin on purpose — they grow by use. */
const SKI_BRANDS: ValueSpec[] = [
  { label: 'Head', attributes: [models(['Kore', 'Supershape', 'Monster', 'e-Rally'])] },
  { label: 'Völkl', attributes: [models(['Kendo', 'Mantra', 'Blaze', 'Deacon', 'Katana'])] },
  { label: 'Rossignol', attributes: [models(['Experience', 'Sender', 'Soul 7', 'Hero'])] },
  { label: 'Atomic', attributes: [models(['Bent', 'Maverick', 'Redster', 'Vantage'])] },
  { label: 'Salomon', attributes: [models(['QST', 'Stance', 'S/Force', 'Addikt'])] },
  { label: 'K2', attributes: [models(['Mindbender', 'Reckoner', 'Disruption'])] },
  { label: 'Blizzard', attributes: [models(['Rustler', 'Black Pearl', 'Brahma', 'Sheeva'])] },
  { label: 'Nordica', attributes: [models(['Enforcer', 'Santa Ana', 'Dobermann'])] },
  { label: 'Fischer', attributes: [models(['Ranger', 'RC4', 'Transalp'])] },
  { label: 'Dynastar', attributes: [models(['M-Pro', 'Speed', 'E-Lite'])] },
  { label: 'Elan', attributes: [models(['Ripstick', 'Wingman', 'Primetime'])] },
  { label: 'Line', attributes: [models(['Blade', 'Pandora', 'Chronic'])] },
  { label: 'Armada', attributes: [models(['ARV', 'Declivity', 'Stranger'])] },
  'Black Crows',
  'DPS',
  'Faction',
  'Stöckli',
];

const BOARD_BRANDS: ValueSpec[] = [
  { label: 'Burton', attributes: [models(['Custom', 'Process', 'Name Dropper', 'Hometown Hero'])] },
  { label: 'Lib Tech', attributes: [models(['Skate Banana', 'Orca', 'Cold Brew'])] },
  { label: 'GNU', attributes: [models(['Riders Choice', 'Ladies Choice', 'Money'])] },
  { label: 'Never Summer', attributes: [models(['Proto', 'Harpoon', 'Swift'])] },
  { label: 'Ride', attributes: [models(['Warpig', 'Algorhythm', 'Shadowban'])] },
  { label: 'Capita', attributes: [models(['DOA', 'Mercury', 'Mega Death'])] },
  'Arbor',
  'Jones',
  'Rome',
  'Salomon',
  'K2',
  'Nitro',
];

const APPAREL_BRANDS = [
  'Arc’teryx', 'Burton', 'Columbia', 'Descente', 'Eddie Bauer', 'Flylow',
  'Helly Hansen', 'Mammut', 'Marmot', 'Mountain Hardwear', 'Norrøna',
  'Obermeyer', 'Outdoor Research', 'Patagonia', 'Picture', 'Spyder',
  'The North Face', 'Trew', 'Volcom', '686',
];

const BOOT_BRANDS: ValueSpec[] = [
  { label: 'Atomic', attributes: [models(['Hawx', 'Redster'])] },
  { label: 'Head', attributes: [models(['Formula', 'Edge', 'Kore'])] },
  { label: 'Lange', attributes: [models(['RX', 'Shadow', 'XT3'])] },
  { label: 'Nordica', attributes: [models(['Speedmachine', 'Promachine', 'HF'])] },
  { label: 'Salomon', attributes: [models(['S/Pro', 'Shift', 'QST'])] },
  { label: 'Tecnica', attributes: [models(['Mach1', 'Cochise', 'Zero G'])] },
  'Dalbello',
  'Fischer',
  'Full Tilt',
  'K2',
  'Rossignol',
  'Scarpa',
];

/** The branch a manufacturer opens: its models, free entry on. */
function models(labels: string[]): AttributeSpec {
  return {
    label: 'Model',
    input: 'SELECT',
    nameSlot: 20,
    allowFreeEntry: true,
    values: labels,
  };
}

function manufacturer(values: ValueSpec[]): AttributeSpec {
  return { label: 'Manufacturer', input: 'SELECT', nameSlot: 10, allowFreeEntry: true, values };
}

function color(slot: number): AttributeSpec {
  return { label: 'Color', input: 'SELECT', nameSlot: slot, icon: 'color', values: COLORS };
}

function condition(): AttributeSpec {
  // No slot: useful in a report, and not worth the room on a 40×30 label.
  return {
    label: 'Condition',
    input: 'SELECT',
    values: ['New', 'Excellent', 'Good', 'Fair', 'Well used'],
  };
}

function gender(slot: number): AttributeSpec {
  return { label: 'Gender', input: 'SELECT', nameSlot: slot, values: GENDERS };
}

function apparelSize(slot: number): AttributeSpec {
  return {
    label: 'Size',
    input: 'SELECT',
    nameSlot: slot,
    icon: 'size',
    values: [...APPAREL_SIZES, ...KIDS_SIZES.map((s) => `Youth ${s}`)],
  };
}

function apparel(label: string, icon: string): CategorySpec {
  return {
    label,
    icon,
    attributes: [
      manufacturer(APPAREL_BRANDS),
      gender(30),
      apparelSize(40),
      color(50),
      condition(),
    ],
  };
}

// ─── The tree ────────────────────────────────────────────────────────────────

export const GLOBAL_TAXONOMY: CategorySpec[] = [
  {
    label: 'Skis',
    icon: 'skis',
    attributes: [
      manufacturer(SKI_BRANDS),
      { label: 'Length', input: 'NUMBER', nameSlot: 30, icon: 'length', unit: 'cm', min: 70, max: 215, step: 1 },
      {
        label: 'Type',
        input: 'SELECT',
        nameSlot: 40,
        values: ['Powder', 'All-mountain', 'Carving', 'Park', 'Touring', 'Race'],
      },
      color(50),
      { label: 'Bindings included', input: 'SELECT', values: ['Yes', 'No'] },
      { label: 'Waist width', input: 'NUMBER', unit: 'mm', min: 60, max: 140, step: 1 },
      condition(),
    ],
  },
  {
    label: 'Snowboard',
    icon: 'snowboard',
    attributes: [
      manufacturer(BOARD_BRANDS),
      { label: 'Length', input: 'NUMBER', nameSlot: 30, icon: 'length', unit: 'cm', min: 90, max: 185, step: 1 },
      { label: 'Shape', input: 'SELECT', nameSlot: 40, values: ['Directional', 'Twin', 'Directional twin', 'Swallowtail'] },
      { label: 'Flex', input: 'SELECT', values: ['Soft', 'Medium', 'Stiff'] },
      color(50),
      { label: 'Bindings included', input: 'SELECT', values: ['Yes', 'No'] },
      condition(),
    ],
  },
  {
    label: 'Ski boots',
    icon: 'ski-boots',
    attributes: [
      manufacturer(BOOT_BRANDS),
      { label: 'Mondopoint', input: 'NUMBER', nameSlot: 30, icon: 'size', unit: '', min: 14, max: 34, step: 0.5 },
      gender(40),
      { label: 'Flex', input: 'NUMBER', icon: 'flex', min: 30, max: 140, step: 5 },
      color(50),
      condition(),
    ],
  },
  {
    label: 'Snowboard boots',
    icon: 'snowboard-boots',
    attributes: [
      manufacturer(['Burton', 'DC', 'K2', 'Nidecker', 'Ride', 'Salomon', 'ThirtyTwo', 'Vans']),
      { label: 'Size', input: 'NUMBER', nameSlot: 30, icon: 'size', unit: '', min: 1, max: 16, step: 0.5 },
      gender(40),
      { label: 'Lacing', input: 'SELECT', values: ['Traditional', 'Speed lace', 'BOA', 'Double BOA'] },
      color(50),
      condition(),
    ],
  },
  {
    label: 'Cross-country skis',
    icon: 'nordic',
    attributes: [
      manufacturer(['Fischer', 'Rossignol', 'Salomon', 'Atomic', 'Madshus', 'Alpina']),
      { label: 'Length', input: 'NUMBER', nameSlot: 30, icon: 'length', unit: 'cm', min: 100, max: 215, step: 5 },
      { label: 'Style', input: 'SELECT', nameSlot: 40, values: ['Classic', 'Skate', 'Backcountry'] },
      { label: 'Base', input: 'SELECT', values: ['Waxable', 'Waxless', 'Skin'] },
      condition(),
    ],
  },
  {
    label: 'Poles',
    icon: 'poles',
    attributes: [
      manufacturer(['Leki', 'Swix', 'Scott', 'Black Diamond', 'Komperdell', 'Goode']),
      { label: 'Length', input: 'NUMBER', nameSlot: 30, icon: 'length', unit: 'cm', min: 70, max: 140, step: 5 },
      color(40),
      condition(),
    ],
  },
  {
    label: 'Helmet',
    icon: 'helmet',
    attributes: [
      manufacturer(['Giro', 'Smith', 'POC', 'Salomon', 'Oakley', 'Sweet Protection', 'Bern', 'Anon']),
      apparelSize(30),
      color(40),
      { label: 'MIPS', input: 'SELECT', values: ['Yes', 'No'] },
      condition(),
    ],
  },
  {
    label: 'Goggles',
    icon: 'goggles',
    attributes: [
      manufacturer(['Oakley', 'Smith', 'Giro', 'Anon', 'POC', 'Dragon', 'Electric']),
      { label: 'Lens', input: 'SELECT', nameSlot: 30, values: ['Clear', 'Low light', 'All conditions', 'Bright sun', 'Photochromic'] },
      color(40),
      condition(),
    ],
  },
  apparel('Jacket', 'jacket'),
  apparel('Pants', 'pants'),
  apparel('Vest', 'vest'),
  apparel('Base layer', 'base-layer'),
  {
    label: 'Gloves',
    icon: 'gloves',
    attributes: [
      manufacturer(APPAREL_BRANDS),
      { label: 'Style', input: 'SELECT', nameSlot: 20, values: ['Glove', 'Mitten'] },
      gender(30),
      apparelSize(40),
      color(50),
      condition(),
    ],
  },
  {
    label: 'Sled',
    icon: 'sled',
    attributes: [
      manufacturer(['Mad River Rocket', 'Hammerhead', 'Paricon', 'Flexible Flyer']),
      color(30),
      condition(),
    ],
  },
  {
    label: 'Bag',
    icon: 'bag',
    attributes: [
      manufacturer(APPAREL_BRANDS),
      { label: 'Holds', input: 'SELECT', nameSlot: 20, values: ['Skis', 'Snowboard', 'Boots', 'Everything'] },
      color(30),
      condition(),
    ],
  },
  {
    label: 'Other',
    icon: 'other',
    attributes: [
      /**
       * The escape hatch (D8): anything the tree cannot describe becomes a
       * pending value under this one question, which is exactly the signal the
       * org needs to grow the tree. One mechanism, not two.
       */
      { label: 'What is it?', input: 'SELECT', nameSlot: 10, allowFreeEntry: true, values: [] },
      color(20),
      condition(),
    ],
  },
];

// ─── Writing it ──────────────────────────────────────────────────────────────

/** Mirrors `dedupeKeyFor` in the service. Global rows, so the scope is fixed. */
function dedupeKey(parentId: string | null, label: string): string {
  return `global:${parentId ?? 'root'}:${label.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

async function upsertNode(
  prisma: PrismaClient,
  node: {
    kind: 'CATEGORY' | 'ATTRIBUTE' | 'VALUE';
    parentId: string | null;
    label: string;
    iconKey?: string;
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
  const existing = await prisma.taxonomyNode.findUnique({ where: { dedupeKey: key }, select: { id: true } });
  if (existing) return existing.id;

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
      dedupeKey: key,
    },
    select: { id: true },
  });
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

export async function seedTaxonomy(prisma: PrismaClient): Promise<void> {
  let written = 0;
  let order = 10;
  for (const category of GLOBAL_TAXONOMY) {
    const categoryId = await upsertNode(prisma, {
      kind: 'CATEGORY',
      parentId: null,
      label: category.label,
      iconKey: category.icon,
      displayOrder: order,
    });
    written += 1;
    order += 10;
    written += await seedAttributes(prisma, categoryId, category.attributes);
  }

  const total = await prisma.taxonomyNode.count({ where: { orgId: null } });
  console.log(`✓ Item taxonomy seeded (${written} checked, ${total} shared nodes)`);
}
