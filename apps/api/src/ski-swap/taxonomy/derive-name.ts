/**
 * Composing an item's name from what was picked (Plan 19 §5).
 *
 * Server-side only. A client may preview the result; it may not supply it,
 * because the name is what the receipt and the printed tag say and those must
 * not depend on a browser agreeing about it.
 */

/** The fields of an ATTRIBUTE node that decide where its answer lands. */
export interface NameAttribute {
  id: string;
  label: string;
  nameSlot: number | null;
  unit: string | null;
  displayOrder: number;
}

/** One answer, already resolved against the tree. */
export interface NameAnswer {
  attribute: NameAttribute;
  /** The picked VALUE's label, for a SELECT. */
  valueLabel?: string | null;
  /** The typed number, for a NUMBER. */
  numberValue?: number | null;
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
 * The item's name: the named answers in slot order, then the category.
 *
 * The category label goes last because English puts the head noun there, and
 * because it is the one part always present — a name is never empty, and an item
 * with no answers at all is simply "Skis".
 *
 * An answer whose attribute has no `nameSlot` is captured and not named: a
 * detail worth having in a report and not on a 40×30 label.
 */
export function deriveName(categoryLabel: string, answers: NameAnswer[]): string {
  const parts = answers
    .filter((a) => a.attribute.nameSlot !== null)
    .sort(
      (a, b) =>
        (a.attribute.nameSlot ?? 0) - (b.attribute.nameSlot ?? 0) ||
        a.attribute.displayOrder - b.attribute.displayOrder ||
        a.attribute.label.localeCompare(b.attribute.label),
    )
    .map(renderAnswer)
    .filter((part): part is string => part !== null && part.trim() !== '');

  // Collapsed rather than joined blindly: a label with a stray double space in
  // it would otherwise reach a tag that has no room to waste.
  return [...parts, categoryLabel].join(' ').replace(/\s+/g, ' ').trim();
}
