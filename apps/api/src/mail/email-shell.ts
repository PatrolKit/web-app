/**
 * The chrome every PatrolKit email wears.
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
 * ## Why a shell rather than five templates
 *
 * There were five, each with its own copy of the same dark card, and they had
 * already drifted — one said "Ski swap management" under the wordmark and one
 * did not. A theme change had to be made five times and got made once. The
 * parts that actually differ between these messages are a heading, a sentence
 * or two, and one button.
 */
export interface EmailShellOptions {
  /** The `<title>`, which some clients show in the preview line. */
  title: string;
  /**
   * Whose message this is, when it is not PatrolKit's own.
   *
   * A seller hears from their club, not from the software the club runs — so
   * where we know which club, the club's name and mark lead and PatrolKit moves
   * to the foot. `logoUrl` must be somewhere a mail client can fetch: a `data:`
   * URI is stripped and there is nothing to fall back to but the name.
   */
  brand?: { name: string; logoUrl?: string | null };
  /** Under the wordmark. Omitted where the message is not about a swap. */
  kicker?: string;
  /** The bold line that says what happened. */
  heading: string;
  /** Paragraphs under the heading. HTML, already escaped by the caller. */
  body: string[];
  action?: { label: string; url: string };
  /** Small print under the action — "if you weren't expecting this…". */
  footnote?: string;
  /**
   * Repeats the action's URL as text at the foot.
   *
   * For a link somebody may need to copy when the button does not survive their
   * client. Off for a message whose button is a convenience rather than the
   * only way through.
   */
  showRawLink?: boolean;
  /**
   * "Powered by PatrolKit" at the foot, with the mark.
   *
   * For a message that led with somebody else's name. On an email whose header
   * already says PatrolKit in red it would be saying it twice.
   */
  poweredByUrl?: string | null;
}

export function emailShell(o: EmailShellOptions): string {
  const paragraphs = o.body
    .map(
      (p) =>
        `<p class="ink" style="color: #111827; margin: 0 0 16px; font-size: 15px; line-height: 1.5;">${p}</p>`,
    )
    .join('\n    ');

  const action = o.action
    ? `
    <table role="presentation" style="border-collapse: collapse; margin: 24px 0 0;">
      <tr>
        <td align="center" bgcolor="#dc2626" style="border-radius: 6px;">
          <a href="${o.action.url}" style="display: inline-block; padding: 13px 30px; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 15px;">${o.action.label}</a>
        </td>
      </tr>
    </table>`
    : '';

  const footnote = o.footnote
    ? `\n    <p class="muted" style="color: #6b7280; font-size: 13px; margin: 28px 0 0;">${o.footnote}</p>`
    : '';

  const rawLink =
    o.showRawLink && o.action
      ? `
    <hr class="rule" style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0 16px;">
    <p class="muted" style="color: #9ca3af; font-size: 12px; margin: 0;">Or copy this link: <span style="word-break: break-all;">${o.action.url}</span></p>`
      : '';

  const kicker = o.kicker
    ? `\n    <p class="muted" style="color: #6b7280; margin: 0 0 28px; font-size: 14px;">${o.kicker}</p>`
    : '\n    <div style="height: 20px;"></div>';

  // Either the club's name and mark, or the PatrolKit wordmark. Never both at
  // the top — the second one belongs at the foot if it belongs anywhere.
  const masthead = o.brand
    ? `<table role="presentation" style="border-collapse: collapse;">
      <tr>
        ${o.brand.logoUrl ? `<td width="44" style="padding-right: 12px; vertical-align: middle;"><img src="${o.brand.logoUrl}" alt="" width="44" height="44" style="display: block; width: 44px; height: 44px; object-fit: contain; border: 0;"></td>` : ''}
        <td style="vertical-align: middle;">
          <span class="ink" style="color: #111827; font-size: 22px; font-weight: 700;">${o.brand.name}</span>
        </td>
      </tr>
    </table>`
    : `<h1 style="color: #dc2626; font-size: 24px; margin: 0 0 8px;">PatrolKit</h1>`;

  /*
   * The mark is a 128px asset, not the 1254px one the web app uses at 14px.
   * A mail client fetches this on every open, and half a megabyte for
   * something rendered at sixteen pixels is a cost somebody else pays.
   */
  const poweredBy = o.poweredByUrl
    ? `
    <table role="presentation" width="100%" style="border-collapse: collapse; margin: 24px 0 0;">
      <tr>
        <td align="center">
          <span class="muted" style="color: #9ca3af; font-size: 12px; vertical-align: middle;">Powered by</span>
          <img src="${o.poweredByUrl}" alt="" width="14" height="14" style="display: inline-block; width: 14px; height: 14px; vertical-align: middle; margin: 0 5px; border-radius: 3px; border: 0;">
          <span class="muted" style="color: #9ca3af; font-size: 12px; vertical-align: middle;">PatrolKit</span>
        </td>
      </tr>
    </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${o.title}</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    @media (prefers-color-scheme: dark) {
      .page  { background: #1a1a1a !important; }
      .card  { background: #252525 !important; }
      .ink   { color: #f9fafb !important; }
      .muted { color: #9ca3af !important; }
      .rule  { border-top-color: #374151 !important; }
    }
  </style>
</head>
<body class="page" style="margin: 0; padding: 0; background: #f6f7f9;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="page" style="background: #f6f7f9; margin: 0; padding: 0;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="card" style="max-width: 520px; background: #ffffff; border-radius: 10px; padding: 36px; font-family: Inter, 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
          <tr>
            <td>
    ${masthead}${kicker}
    <p class="ink" style="color: #111827; margin: 0 0 12px; font-size: 18px; font-weight: 700;">${o.heading}</p>
    ${paragraphs}${action}${footnote}${rawLink}${poweredBy}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
