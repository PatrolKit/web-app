import type { ReceiptView } from './receipt.service';

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
  const rows = view.lines
    .map(
      (l) => `
      <tr>
        <td class="line" style="padding: 10px 0; border-bottom: 1px solid #e5e7eb;">
          <span class="ink" style="color: #111827; font-size: 15px;">${esc(l.name)}</span><br>
          <span class="muted" style="color: #6b7280; font-size: 12px;">${esc(l.sku)}</span>
        </td>
        <td class="line" style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; text-align: right; vertical-align: top; white-space: nowrap;">
          <span class="ink" style="color: #111827; font-size: 15px; font-weight: 600;">${money(l.priceCents)}</span>
        </td>
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

              <table role="presentation" width="100%" style="border-collapse: collapse; margin-top: 20px;">
                ${view.lines.length ? rows : empty}
                <tr>
                  <td class="total" style="padding: 14px 0 0; border-top: 2px solid #d1d5db;">
                    <span class="muted" style="color: #6b7280; font-size: 14px;">${view.itemCount} item${view.itemCount === 1 ? '' : 's'}</span>
                  </td>
                  <td class="total" style="padding: 14px 0 0; border-top: 2px solid #d1d5db; text-align: right;">
                    <span class="ink" style="color: #111827; font-size: 20px; font-weight: 700;">${money(view.totalCents)}</span>
                  </td>
                </tr>
              </table>

              ${payout}

              <table role="presentation" width="100%" style="border-collapse: collapse; margin: 28px 0 0;">
                <tr>
                  <td align="center" bgcolor="#dc2626" style="border-radius: 6px;">
                    <a href="${view.trackUrl}" style="display: inline-block; padding: 13px 30px; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 15px;">Track your items</a>
                  </td>
                </tr>
              </table>
              <p class="muted" style="color: #6b7280; font-size: 13px; margin: 12px 0 0; text-align: center;">
                See what has sold and what is still on the floor.
              </p>

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
  const tail = `: your ${view.swapTitle} receipt — ${view.itemCount} item${
    view.itemCount === 1 ? '' : 's'
  }, ${money(view.totalCents)}. ${view.url}`;
  const room = 160 - tail.length;
  const org = view.orgName.length > room ? `${view.orgName.slice(0, Math.max(1, room - 1))}…` : view.orgName;
  return `${org}${tail}`;
}
