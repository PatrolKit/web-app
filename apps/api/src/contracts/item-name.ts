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
  const texts = parts.map((p) => p.text.trim()).filter((t) => t !== '');
  let words: string[];
  if (isCatchAllCategory(categoryLabel)) {
    const noun = parts.find((p) => p.freeEntry && p.text.trim() !== '');
    if (noun) words = [...parts.filter((p) => p !== noun).map((p) => p.text), noun.text, ...extra];
    else words = extra.length ? [...texts, ...extra] : [...texts, categoryLabel];
  } else {
    words = [...texts, categoryLabel, ...extra];
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}
