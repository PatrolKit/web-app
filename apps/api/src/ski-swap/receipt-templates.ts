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
 * The link is for keeping, not for reading — somebody opening this on a phone
 * at the swap should not have to follow it to find out what they dropped off.
 * House style from `mail.service.ts`: dark card, brand-red heading, one action.
 */
export function receiptEmail(view: ReceiptView): string {
  const rows = view.lines
    .map(
      (l) => `
      <tr>
        <td style="padding: 8px 0; border-bottom: 1px solid #333;">
          <span style="color: #fff; font-size: 14px;">${esc(l.name)}</span><br>
          <span style="color: #6b7280; font-size: 12px;">${esc(l.sku)}</span>
        </td>
        <td style="padding: 8px 0; border-bottom: 1px solid #333; text-align: right; vertical-align: top; white-space: nowrap;">
          <span style="color: #fff; font-size: 14px; font-weight: 600;">${money(l.priceCents)}</span>
        </td>
      </tr>`,
    )
    .join('');

  const empty = `
      <tr><td colspan="2" style="padding: 12px 0; color: #9ca3af; font-size: 14px;">
        No items were checked in.
      </td></tr>`;

  const payout = view.payoutLabel
    ? `<p style="color: #9ca3af; font-size: 13px; margin: 24px 0 0;">
         Payment goes to: <strong style="color: #e5e7eb;">${esc(view.payoutLabel)}</strong>
       </p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Your ${esc(view.swapTitle)} receipt</title></head>
<body style="font-family: Inter, 'Plus Jakarta Sans', sans-serif; background: #1a1a1a; color: #fff; margin: 0; padding: 40px 20px;">
  <div style="max-width: 520px; margin: 0 auto; background: #252525; border-radius: 8px; padding: 40px;">
    <h1 style="color: #dc2626; font-size: 24px; margin: 0 0 8px;">${esc(view.orgName)}</h1>
    <p style="color: #9ca3af; margin: 0 0 4px; font-size: 14px;">${esc(view.swapTitle)}</p>
    <p style="color: #6b7280; margin: 0 0 28px; font-size: 13px;">
      Checked in ${esc(whenText(view.createdAt))} · ${esc(view.sellerName)}
    </p>

    <table style="width: 100%; border-collapse: collapse;">
      ${view.lines.length ? rows : empty}
      <tr>
        <td style="padding: 14px 0 0; color: #9ca3af; font-size: 14px;">
          ${view.itemCount} item${view.itemCount === 1 ? '' : 's'}
        </td>
        <td style="padding: 14px 0 0; text-align: right;">
          <span style="color: #fff; font-size: 18px; font-weight: 700;">${money(view.totalCents)}</span>
        </td>
      </tr>
    </table>

    <p style="margin: 32px 0 0;">
      <a href="${view.url}" style="display: inline-block; background: #dc2626; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600;">View this receipt</a>
    </p>
    <p style="color: #6b7280; font-size: 13px; margin: 16px 0 0;">
      Keep that link — it also shows what has sold.
    </p>
    ${payout}
    <hr style="border: none; border-top: 1px solid #333; margin: 24px 0;">
    <p style="color: #4b5563; font-size: 12px; margin: 0;">Or copy this link: <span style="word-break: break-all; color: #9ca3af;">${view.url}</span></p>
  </div>
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
