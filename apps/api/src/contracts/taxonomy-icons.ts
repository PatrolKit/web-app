/**
 * The icon keys a `TaxonomyNode` may carry (Plan 19 D11).
 *
 * Deliberately free of imports. The web app reaches this file through the
 * `@patrolkit/contracts` alias to build its `Record<TaxonomyIconKey,
 * IconDefinition>` map, and anything imported here — `zod`, `nestjs-zod`, and
 * NestJS behind it — would be dragged into the browser bundle along with it.
 *
 * A key is never a Font Awesome name. This list is the contract; which glyph
 * each key draws is the web app's business, and the compiler enforces that
 * every key has one because the map is typed as a total `Record`.
 *
 * Adding a key here without adding it to `apps/web/src/lib/taxonomyIcons.ts`
 * fails the web type-check, which is the whole point of keeping the two in step
 * this way rather than with a runtime test.
 */
export const TAXONOMY_ICON_KEYS = [
  // Gear
  'skis',
  'snowboard',
  'ski-boots',
  'snowboard-boots',
  'nordic',
  'poles',
  'helmet',
  'goggles',
  'sled',
  'skates',
  'bike',
  'kayak',
  // Apparel
  'jacket',
  'vest',
  'pants',
  'shirt',
  'base-layer',
  'gloves',
  'socks',
  'hat',
  'scarf',
  'boots',
  'sunglasses',
  // Bags and sundries
  'bag',
  'suitcase',
  'box',
  'tag',
  'other',
  // Attribute-ish: measures and qualities
  'length',
  'size',
  'weight',
  'flex',
  'width',
  'color',
  'palette',
  'gauge',
  'ruler',
  // People
  'person',
  'person-dress',
  'child',
  'children',
  'baby',
  // Conditions and terrain
  'powder',
  'mountain',
  'mountains',
  'snowflake',
  'sun',
  'cloud',
  'wind',
  'water',
  'temperature',
  'leaf',
  'fire',
  // Generic shapes, for anything the list above does not reach
  'star',
  'heart',
  'shield',
  'flag',
  'bolt',
  'circle',
  'square',
  'diamond',
  'cube',
  'layers',
  'shapes',
  'list',
  'grid',
  'sliders',
  'gear',
  'wrench',
  'tools',
  'trophy',
  'compass',
  'map',
  'pin',
  'house',
  'life-ring',
  'question',
] as const;

export type TaxonomyIconKey = (typeof TAXONOMY_ICON_KEYS)[number];

export function isTaxonomyIconKey(value: string): value is TaxonomyIconKey {
  return (TAXONOMY_ICON_KEYS as readonly string[]).includes(value);
}
