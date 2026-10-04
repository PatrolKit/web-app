/** A receipt's button, whichever status page it opens: the email's words. */
export const RECEIPT_LINK_BUTTON = 'Click here to check the status of your items';

/** What a status-page-only receipt says in place of its items. */
export const RECEIPT_THANKS = 'Thank you for participating in our ski swap!';

/**
 * A swap's fine print, in its callout (Plan 36 D12). The HTML is the server's,
 * sanitized to paragraphs, bold, italic, links and lists, or the dialog's
 * editor, which can't make anything else.
 */
export function FinePrintCallout({ html }: { html: string }) {
  return (
    <div
      className="bg-surface-100 rounded-lg px-4 py-3 text-xs leading-relaxed text-gray-400
        [&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5
        [&_ul]:mb-2 [&_ol]:mb-2 [&_li]:mb-1 [&_strong]:text-gray-200 [&_a]:text-brand-500 [&_a]:underline"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
