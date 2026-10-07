/**
 * The last step of an item's name (Plan 19 §5), shared by the server's
 * `deriveName`, the item form's preview and Fast Edit, so all three agree.
 *
 * The named answers, already in slot order, then the category's label: the
 * category is the noun, "Red Burton Jacket". Except in "Other", which is no
 * noun: there the item is whatever the seller said it is, so that answer goes
 * last in its place. A red sled is "Red Sled", not "Sled Red Other". With
 * nothing said, "Other" stays, so a name is never empty.
 */

export interface NamePart {
  text: string;
  /** The answer to a question that takes typed values: in "Other", what the item is. */
  freeEntry?: boolean;
  /** Said after the noun, as a measurement is: "Ski boots MP 26.5". */
  afterNoun?: boolean;
}

/** The category whose label says nothing about the item. */
export function isCatchAllCategory(categoryLabel: string): boolean {
  return categoryLabel.trim().toLowerCase() === 'other';
}

/**
 * The name, from its ordered parts. `extra` is Fast Edit's words that matched
 * nothing, kept as typed after the name; in "Other" with nothing else saying
 * what the item is, they say it, and "Other" goes.
 */
export function composeName(parts: NamePart[], categoryLabel: string, extra: string[] = []): string {
  const after = parts.filter((p) => p.afterNoun).map((p) => p.text);
  const before = parts.filter((p) => !p.afterNoun);
  const texts = before.map((p) => p.text.trim()).filter((t) => t !== '');
  let words: string[];
  if (isCatchAllCategory(categoryLabel)) {
    const noun = before.find((p) => p.freeEntry && p.text.trim() !== '');
    if (noun) words = [...before.filter((p) => p !== noun).map((p) => p.text), noun.text, ...after, ...extra];
    else words = extra.length ? [...texts, ...after, ...extra] : [...texts, categoryLabel, ...after];
  } else {
    words = [...texts, categoryLabel, ...after, ...extra];
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

// ─── A ski boot's size ───────────────────────────────────────────────────────

/** The question that is a ski boot's size, by its label as the tree has it. */
export function isMondopoint(attributeLabel: string): boolean {
  return attributeLabel.trim().toLowerCase() === 'mondopoint';
}

const half = (n: number) => Math.round(n * 2) / 2;
const digits = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1))));

/** Kids' boots by Mondopoint: little kids' (C) sizes, then youth (Y), as agreed with the patrol. */
const KIDS: Record<string, string> = {
  '14': 'C 6.5', '14.5': 'C 7', '15': 'C 7.5', '15.5': 'C 8', '16': 'C 8.5', '16.5': 'C 9', '17': 'C 9.5',
  '17.5': 'C 10', '18': 'C 10.5', '18.5': 'C 11', '19': 'C 12', '19.5': 'C 13', '20': 'Y 1', '20.5': 'Y 1.5',
  '21': 'Y 2.5', '21.5': 'Y 3', '22': 'Y 4', '22.5': 'Y 4.5', '23': 'Y 5', '23.5': 'Y 5.5', '24': 'Y 6',
  '24.5': 'Y 6.5', '25': 'Y 7',
};

/**
 * The US size for a Mondopoint, by who the boot is for: men's is MP − 18,
 * women's MP − 17, kids' from the table above (men's past MP 25). Null for a
 * boot that isn't marked Mens, Womens or Kids, and for a size off the chart.
 * Charts differ by about half a size; the MP is what's exact.
 */
export function usBootSize(mondopoint: number, gender: string | null | undefined): string | null {
  const mp = half(mondopoint);
  const who = gender?.trim().toLowerCase();
  const adult = (prefix: 'M' | 'W', offset: number) => (mp - offset >= 1 ? `${prefix} ${digits(mp - offset)}` : null);
  if (who === 'mens') return adult('M', 18);
  if (who === 'womens') return adult('W', 17);
  if (who === 'kids') return mp > 25 ? adult('M', 18) : (KIDS[digits(mp)] ?? null);
  return null;
}

/** How a boot's size reads in its name: "MP 26.5", or "MP 26.5 (US M 8.5)" where the org shows US sizes. */
export function bootSizeText(mondopoint: number, gender: string | null | undefined, showUs: boolean): string {
  const mp = `MP ${digits(mondopoint)}`;
  const us = showUs ? usBootSize(mondopoint, gender) : null;
  return us ? `${mp} (US ${us})` : mp;
}
