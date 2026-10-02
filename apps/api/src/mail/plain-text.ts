import { convert } from 'html-to-text';

/**
 * The plain-text part sent alongside every HTML email.
 *
 * HTML with no text alternative is a small mark against a message with spam
 * filters, and it leaves a text-only mail client with nothing useful to show.
 * Derived from the HTML rather than written twice, so the two cannot drift.
 */
export function plainText(html: string): string {
  return convert(html, {
    wordwrap: 100,
    selectors: [
      // The logo and spacer images carry nothing a reader of plain text needs.
      { selector: 'img', format: 'skip' },
      // A button's label and its link, on one line: "Sign in [https://…]".
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      // Every table here is layout, except a receipt's item list. A row on a line
      // of its own keeps one item from running into the next.
      { selector: 'tr', format: 'block' },
    ],
  })
    // Layout cells that held only an image leave runs of empty lines behind.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
