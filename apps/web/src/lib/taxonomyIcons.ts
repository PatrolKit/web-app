import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faBabyCarriage, faBagShopping, faBicycle, faBolt, faBoot, faBoxOpen, faChild,
  faChildren, faCircle, faCloud, faCompass, faCube, faDiamond, faDroplet,
  faFire, faFlag, faGaugeHigh, faGear, faHatWinter, faHeart, faHelmetSafety,
  faHouse, faKayak, faLayerGroup, faLeaf, faLifeRing, faListUl, faLocationDot, faMap,
  faMasksTheater, faMitten, faMountain, faMountains, faPalette, faPerson,
  faPersonDress, faPersonSkating, faPersonSkiing, faPersonSnowboarding,
  faQuestion, faRuler, faRulerHorizontal, faRulerVertical, faScarf, faShapes,
  faShieldHalved, faShirtLongSleeve, faSkiBoot, faSkiBootSki, faSkiingNordic,
  faSkiLift, faSledding, faSliders, faSnowflake, faSocks, faSquare, faStar,
  faSuitcase, faSun, faSunglasses, faTableCells, faTag, faTemperatureHalf,
  faTrophy, faVest, faWater, faWeightHanging, faWind, faWrench,
} from '@fortawesome/pro-duotone-svg-icons';
import { TAXONOMY_ICON_KEYS, type TaxonomyIconKey } from '@patrolkit/contracts/taxonomy-icons';

/**
 * Which glyph each taxonomy icon key draws (Plan 19 §4.4).
 *
 * Static named imports, like every other icon in this app, so the bundler drops
 * the rest of the Pro set. There is no `library.add` and no `findIconDefinition`
 * anywhere in here on purpose: resolving a database string against the whole
 * duotone set would add megabytes to the bundle a seller's phone pulls over
 * venue wifi, and that is the client least able to afford it.
 *
 * Typed as a total `Record`, which is what keeps this file in step with the
 * contract: adding a key there without adding it here fails the type-check,
 * rather than being discovered as a blank chip at a check-in table.
 *
 * Several keys share a glyph — Font Awesome has no ski pole or jacket, so poles
 * borrow the lift and jacket borrows the long-sleeve shirt. A near glyph reads
 * better on a category chip than no glyph at all.
 */
export const TAXONOMY_ICONS: Record<TaxonomyIconKey, IconDefinition> = {
  // Gear
  skis: faPersonSkiing,
  snowboard: faPersonSnowboarding,
  'ski-boots': faSkiBoot,
  'snowboard-boots': faSkiBootSki,
  nordic: faSkiingNordic,
  poles: faSkiLift,
  helmet: faHelmetSafety,
  goggles: faMasksTheater,
  sled: faSledding,
  skates: faPersonSkating,
  bike: faBicycle,
  kayak: faKayak,
  // Apparel
  jacket: faShirtLongSleeve,
  vest: faVest,
  pants: faPerson,
  shirt: faShirtLongSleeve,
  'base-layer': faShirtLongSleeve,
  gloves: faMitten,
  socks: faSocks,
  hat: faHatWinter,
  scarf: faScarf,
  boots: faBoot,
  sunglasses: faSunglasses,
  // Bags and sundries
  bag: faBagShopping,
  suitcase: faSuitcase,
  box: faBoxOpen,
  tag: faTag,
  other: faBoxOpen,
  // Measures and qualities
  length: faRulerHorizontal,
  size: faRulerVertical,
  weight: faWeightHanging,
  flex: faGaugeHigh,
  width: faRuler,
  color: faDroplet,
  palette: faPalette,
  gauge: faGaugeHigh,
  ruler: faRuler,
  // People
  person: faPerson,
  'person-dress': faPersonDress,
  child: faChild,
  children: faChildren,
  baby: faBabyCarriage,
  // Conditions and terrain
  powder: faSnowflake,
  mountain: faMountain,
  mountains: faMountains,
  snowflake: faSnowflake,
  sun: faSun,
  cloud: faCloud,
  wind: faWind,
  water: faWater,
  temperature: faTemperatureHalf,
  leaf: faLeaf,
  fire: faFire,
  // Generic shapes
  star: faStar,
  heart: faHeart,
  shield: faShieldHalved,
  flag: faFlag,
  bolt: faBolt,
  circle: faCircle,
  square: faSquare,
  diamond: faDiamond,
  cube: faCube,
  layers: faLayerGroup,
  shapes: faShapes,
  list: faListUl,
  grid: faTableCells,
  sliders: faSliders,
  gear: faGear,
  wrench: faWrench,
  tools: faWrench,
  trophy: faTrophy,
  compass: faCompass,
  map: faMap,
  pin: faLocationDot,
  house: faHouse,
  'life-ring': faLifeRing,
  question: faQuestion,
};

export { TAXONOMY_ICON_KEYS };
export type { TaxonomyIconKey };

/** Null for a key this build does not know, which renders as no icon at all. */
export function taxonomyIcon(key: string | null | undefined): IconDefinition | null {
  if (!key) return null;
  return TAXONOMY_ICONS[key as TaxonomyIconKey] ?? null;
}
