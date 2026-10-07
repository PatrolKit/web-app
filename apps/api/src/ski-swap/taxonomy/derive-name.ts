/**
 * Composing an item's name from what was picked (Plan 19 §5).
 *
 * Server-side only. A client may preview the result; it may not supply it,
 * because the name is what the receipt and the printed tag say and those must
 * not depend on a browser agreeing about it.
 */

import { bootSizeText, composeName, isMondopoint } from '../../contracts/item-name';

/** The fields of an ATTRIBUTE node that decide where its answer lands. */
export interface NameAttribute {
  id: string;
  label: string;
  nameSlot: number | null;
  unit: string | null;
  displayOrder: number;
  /** Takes typed values. In "Other", its answer is what the item is. */
  allowFreeEntry?: boolean;
}

/** One answer, already resolved against the tree. */
export interface NameAnswer {
  attribute: NameAttribute;
  /** The picked VALUE's label, for a SELECT. */
  valueLabel?: string | null;
  /** The typed number, for a NUMBER. */
  numberValue?: number | null;
  /**
   * Reached through a "same details as" pointer (Plan 44 D14): a ski's binding
   * answers. Captured, never named — the ski is "Völkl Mantra 170 Skis",
   * whatever is screwed to it (D15).
   */
  viaPointer?: boolean;
}

/**
 * Renders one answer the way it appears in a name.
 *
 * A number carries its unit with no space — 112 + "cm" ⇒ "112cm" — and loses a
 * trailing ".0", because "112cm" is what is written on a ski and "112.0cm" is
 * not. `Number.isInteger` rather than a regex on the formatted string: the value
 * is a float out of MySQL and the question is about the number, not its text.
 */
export function renderAnswer(answer: NameAnswer): string | null {
  if (answer.valueLabel != null && answer.valueLabel !== '') return answer.valueLabel;
  if (answer.numberValue == null) return null;
  const n = answer.numberValue;
  const digits = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
  return `${digits}${answer.attribute.unit ?? ''}`;
}

/**
 * The item's name: the named answers in slot order, then the category. In
 * "Other", the answer that says what the item is takes the category's place
 * (`composeName`).
 *
 * The category label goes last because English puts the head noun there, and
 * because it is the one part always present — a name is never empty, and an item
 * with no answers at all is simply "Skis".
 *
 * An answer whose attribute has no `nameSlot` is captured and not named: a
 * detail worth having in a report and not on a 40×30 label.
 */
export function deriveName(categoryLabel: string, answers: NameAnswer[], opts: { showUsBootSizes?: boolean } = {}): string {
  // A ski boot's size goes after the noun, as "MP 26.5", with its US size
  // when the org shows them and the boot says who it's for.
  const gender = answers.find((a) => a.attribute.label.trim().toLowerCase() === 'gender')?.valueLabel ?? null;
  const parts = answers
    .filter((a) => a.attribute.nameSlot !== null && !a.viaPointer)
    .sort(
      (a, b) =>
        (a.attribute.nameSlot ?? 0) - (b.attribute.nameSlot ?? 0) ||
        a.attribute.displayOrder - b.attribute.displayOrder ||
        a.attribute.label.localeCompare(b.attribute.label),
    )
    .map((a) => (isMondopoint(a.attribute.label) && a.numberValue != null
      ? { text: bootSizeText(a.numberValue, gender, !!opts.showUsBootSizes), afterNoun: true }
      : { text: renderAnswer(a) ?? '', freeEntry: !!a.attribute.allowFreeEntry }))
    .filter((part) => part.text.trim() !== '');

  // Collapsed rather than joined blindly: a label with a stray double space in
  // it would otherwise reach a tag that has no room to waste.
  return composeName(parts, categoryLabel);
}
