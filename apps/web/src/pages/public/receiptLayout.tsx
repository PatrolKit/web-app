import type { ReceiptLayout } from '../../lib/api.types';

type LinkKind = NonNullable<ReceiptLayout['link']>['kind'];

/** A receipt's link, said by where it goes (Plan 36): the email's words. */
export const RECEIPT_LINK_LABELS: Record<LinkKind, { button: string; caption: string }> = {
  SKU_LOOKUP: { button: 'Check an item', caption: 'Enter a SKU to see whether it has sold.' },
  SELLER_STATUS: { button: 'Track your items', caption: 'See what has sold and what is still on the floor.' },
  SELLER_LOGIN: { button: 'Sign in to see your items', caption: 'Sign in to see everything you’re selling.' },
};

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
