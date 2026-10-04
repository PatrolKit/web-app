import type { ReceiptView } from './receipt.service';
import { LINK_LABELS, type LinkKind } from './receipt-layout';
import { sanitizeFinePrint } from './receipt-settings';

/** What each link is for, under its button (Plan 36). */
const LINK_CAPTIONS: Record<LinkKind, string> = {
  SKU_LOOKUP: 'Enter a SKU to see whether it has sold.',
  SELLER_STATUS: 'See what has sold and what is still on the floor.',
  SELLER_LOGIN: 'Sign in to see everything you’re selling.',
};

/**
 * Fine print for an email (Plan 36 D12): sanitized again here, then given
 * inline styles, since several mail clients strip a `<style>` block.
 */
function emailFinePrint(html: string): string {
  return sanitizeFinePrint(html)
    .replace(/<p>/g, '<p style="margin: 0 0 8px;">')
    .replace(/<(ul|ol)>/g, '<$1 style="margin: 0 0 8px; padding-left: 20px;">')
    .replace(/<li>/g, '<li style="margin: 0 0 4px;">')
    .replace(/<a href=/g, '<a style="color: #dc2626;" href=');
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** A line's price, or that it has none yet: a ticket priced after check-in. */
function linePrice(cents: number | null): string {
  return cents === null ? 'Price to come' : money(cents);
}

function itemCountText(view: ReceiptView): string {
  return `${view.itemCount} item${view.itemCount === 1 ? '' : 's'}`;
}

/** "3 items", and how many of them have no price yet. */
function countText(view: ReceiptView): string {
  const items = `${view.itemCount} item${view.itemCount === 1 ? '' : 's'}`;
  return view.unpricedCount ? `${items} · ${view.unpricedCount} with price to come` : items;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function whenText(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * The receipt, in the body.
 *
 * ## Light base, dark override
 *
 * Mail clients are split. Apple Mail, iOS Mail and Outlook for Mac honor
 * `prefers-color-scheme`; Gmail and Outlook for Windows ignore it entirely and
 * render whatever the base styles say. So the base has to be one or the other,
 * and it is light: that is what the clients which ignore the query will show,
 * it prints, and it survives being forwarded into a quoted thread.
 *
 * The dark rules live in a `<style>` block, which several clients strip — hence
 * every element also carrying inline styles for the light case. Where a color
 * has to change in dark mode it gets a class as well, so the inline value is
 * the light default and the class is the override. `color-scheme` tells a
 * client not to invert anything itself on top of that.
 *
 * ## Why no "view receipt" button
 *
 * The receipt is right here. A button to go and read it somewhere else is an
 * instruction to leave the thing you are already looking at. The link is still
 * at the foot for keeping and forwarding; the one button that earns its place
 * goes somewhere the email cannot: the seller's live page.
 */
export function receiptEmail(view: ReceiptView): string {
  const { layout } = view;
  const { show } = layout;
  // The name leads when it's shown; otherwise the SKU takes its place (D7).
  const rows = view.lines
    .map(
      (l) => `
      <tr>
        <td class="line" style="padding: 10px 0; border-bottom: 1px solid #e5e7eb;">
          ${show.name ? `<span class="ink" style="color: #111827; font-size: 15px;">${esc(l.name)}</span>` : ''}
          ${show.name && show.sku ? '<br>' : ''}
          ${show.sku ? `<span class="${show.name ? 'muted' : 'ink'}" style="color: ${show.name ? '#6b7280' : '#111827'}; font-size: ${show.name ? '12' : '15'}px;">${esc(l.sku)}</span>` : ''}
        </td>
        ${show.price ? `<td class="line" style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: right; vertical-align: top; white-space: nowrap;">
          <span class="ink" style="color: #111827; font-size: 15px; font-weight: ${l.priceCents === null ? '400' : '600'};">${linePrice(l.priceCents)}</span>
        </td>` : ''}
      </tr>`,
    )
    .join('');

  const empty = `
      <tr><td colspan="2" class="muted" style="padding: 12px 0; color: #6b7280; font-size: 14px;">
        No items were checked in.
      </td></tr>`;

  /*
   * The payout is the answer to "when do I get my money", so it is a panel
   * rather than a line of small print under the total. Left border and a fill,
   * because a mail client that drops the background still leaves the rule.
   */
  const payout = view.payoutLabel
    ? `
    <table role="presentation" width="100%" style="border-collapse: collapse; margin: 24px 0 0;">
      <tr>
        <td class="panel" style="background: #f3f4f6; border-left: 4px solid #dc2626; border-radius: 4px; padding: 14px 16px;">
          <div class="muted" style="color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em;">Payment goes to</div>
          <div class="ink" style="color: #111827; font-size: 17px; font-weight: 700; margin-top: 4px;">${esc(view.payoutLabel)}</div>
        </td>
      </tr>
    </table>`
    : '';

  // Itemized: the table, its columns per the settings. Price off takes the
  // total with it (D7).
  const itemized = `
              <table role="presentation" width="100%" style="border-collapse: collapse; margin-top: 20px;">
                ${view.lines.length ? rows : empty}
                <tr>
                  <td class="total" style="padding: 14px 0 0; border-top: 2px solid #d1d5db;">
                    <span class="muted" style="color: #6b7280; font-size: 14px;">${esc(show.price ? countText(view) : itemCountText(view))}</span>
                  </td>
                  ${show.price ? `<td class="total" style="padding: 14px 0 0; border-top: 2px solid #d1d5db; text-align: right;">
                    ${view.unpricedCount ? '<span class="muted" style="color: #6b7280; font-size: 12px;">Total of priced items</span><br>' : ''}
                    <span class="ink" style="color: #111827; font-size: 20px; font-weight: 700;">${money(view.totalCents)}</span>
                  </td>` : ''}
                </tr>
              </table>`;

  // Status page only: no items, just where to follow them (D6). If the page
  // has since been turned off, say so rather than leave the receipt blank (D2).
  const statusOnly = `
              <p class="ink" style="color: #111827; font-size: 16px; margin: 20px 0 0;">
                Your ${itemCountText(view)} ${view.itemCount === 1 ? 'is' : 'are'} checked in.
              </p>
              ${layout.link ? '' : '<p class="muted" style="color: #6b7280; font-size: 14px; margin: 8px 0 0;">The swap’s status page isn’t available right now.</p>'}`;

  const linkButton = layout.link
    ? `
              <table role="presentation" width="100%" style="border-collapse: collapse; margin: 28px 0 0;">
                <tr>
                  <td align="center" bgcolor="#dc2626" style="border-radius: 6px;">
                    <a href="${esc(layout.link.url)}" style="display: inline-block; padding: 13px 30px; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 15px;">${esc(LINK_LABELS[layout.link.kind].button)}</a>
                  </td>
                </tr>
              </table>
              <p class="muted" style="color: #6b7280; font-size: 13px; margin: 12px 0 0; text-align: center;">
                ${esc(LINK_CAPTIONS[layout.link.kind])}
              </p>`
    : '';

  // The fine print's callout sits above the separator before the foot (D12).
  const finePrint = layout.finePrint
    ? `
              <table role="presentation" width="100%" style="border-collapse: collapse; margin: 28px 0 0;">
                <tr>
                  <td class="panel" style="background: #f3f4f6; border-radius: 4px; padding: 14px 16px 6px; color: #4b5563; font-size: 13px; line-height: 1.5;">
                    <div class="muted ink" style="color: #4b5563;">${emailFinePrint(layout.finePrint)}</div>
                  </td>
                </tr>
              </table>`
    : '';

  const logo = view.logoImageUrl
    ? `<img src="${view.logoImageUrl}" alt="" width="48" height="48" style="display: block; width: 48px; height: 48px; object-fit: contain; border: 0;">`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Your ${esc(view.swapTitle)} receipt</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    @media (prefers-color-scheme: dark) {
      .page   { background: #1a1a1a !important; }
      .card   { background: #252525 !important; }
      .ink    { color: #f9fafb !important; }
      .muted  { color: #9ca3af !important; }
      .line   { border-bottom-color: #374151 !important; }
      .rule   { border-top-color: #374151 !important; }
      .panel  { background: #31241f !important; }
      .total  { border-top-color: #4b5563 !important; }
    }
  </style>
</head>
<body class="page" style="margin: 0; padding: 0; background: #f6f7f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="page" style="background: #f6f7f9; margin: 0; padding: 0;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="card" style="max-width: 560px; background: #ffffff; border-radius: 10px; padding: 32px; font-family: Inter, 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
          <tr>
            <td>

              <table role="presentation" width="100%" style="border-collapse: collapse;">
                <tr>
                  ${logo ? `<td width="48" style="padding-right: 12px; vertical-align: top;">${logo}</td>` : ''}
                  <td style="vertical-align: top;">
                    <div class="ink" style="color: #111827; font-size: 20px; font-weight: 700;">${esc(view.orgName)}</div>
                    <div class="muted" style="color: #6b7280; font-size: 14px; margin-top: 2px;">${esc(view.swapTitle)}</div>
                  </td>
                </tr>
              </table>

              <p class="muted" style="color: #6b7280; font-size: 13px; margin: 16px 0 0;">
                Checked in ${esc(whenText(view.createdAt))} · ${esc(view.sellerName)}
              </p>

              ${layout.mode === 'STATUS_ONLY' ? statusOnly : itemized}

              ${payout}

              ${linkButton}

              ${finePrint}

              <hr class="rule" style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0 16px;">
              <p class="muted" style="color: #9ca3af; font-size: 12px; margin: 0;">
                A copy of this receipt lives at
                <a href="${view.url}" class="muted" style="color: #9ca3af; word-break: break-all;">${view.url}</a>
              </p>

              <!-- The club's name leads this email, so the attribution sits at
                   the foot the way it does on every seller-facing page. The
                   mark is a 128px asset rather than the 1254px one the web app
                   uses at 14px: a client fetches this on every open. -->
              <table role="presentation" width="100%" style="border-collapse: collapse; margin: 20px 0 0;">
                <tr>
                  <td align="center">
                    <span class="muted" style="color: #9ca3af; font-size: 12px; vertical-align: middle;">Powered by</span>
                    <img src="${view.brandMarkUrl}" alt="" width="14" height="14" style="display: inline-block; width: 14px; height: 14px; vertical-align: middle; margin: 0 5px; border-radius: 3px; border: 0;">
                    <span class="muted" style="color: #9ca3af; font-size: 12px; vertical-align: middle;">PatrolKit</span>
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * One message, under 160 characters so a carrier does not split it.
 *
 * Everything but the headline lives behind the link, which is why the route is
 * `/r/` and not `/receipts/`. The org name is trimmed rather than the URL: a
 * truncated link is useless, a truncated club name is still recognisable.
 */
export function receiptSms(view: ReceiptView): string {
  const { layout } = view;
  // Status page only carries the status link itself; everything else links to
  // the receipt page (Plan 36). Price off leaves the total out.
  const tail = layout.mode === 'STATUS_ONLY' && layout.link
    ? `: your ${view.swapTitle} items are checked in. ${LINK_LABELS[layout.link.kind].button}: ${layout.link.url}`
    : `: your ${view.swapTitle} receipt — ${itemCountText(view)}${
        layout.show.price
          ? `, ${money(view.totalCents)}${view.unpricedCount ? `, ${view.unpricedCount} not yet priced` : ''}`
          : ''
      }. ${view.url}`;
  const room = 160 - tail.length;
  const org = view.orgName.length > room ? `${view.orgName.slice(0, Math.max(1, room - 1))}…` : view.orgName;
  return `${org}${tail}`;
}
