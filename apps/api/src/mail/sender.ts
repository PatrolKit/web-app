/**
 * The From header, with a name a recipient recognizes.
 *
 * A bare `noreply@patrolkit.io` reads as nobody in particular, and an unfamiliar
 * sender is one more reason to press "Report spam". The name is the club the
 * recipient belongs to when there is exactly one; otherwise PatrolKit, because
 * naming one of several would be a guess about which club the mail is for.
 */
export const PLATFORM_SENDER_NAME = 'PatrolKit';

/** Display names are cut here; a header is no place for a paragraph. */
const NAME_MAX = 64;

/** `"Name" <address>`, quoted for ASCII and RFC 2047-encoded otherwise. */
export function formatSender(name: string, address: string): string {
  // CR and LF would let a name smuggle in headers of its own.
  const clean = name.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || PLATFORM_SENDER_NAME;
  if (/^[\x20-\x7e]*$/.test(clean)) return `"${clean.replace(/(["\\])/g, '\\$1')}" <${address}>`;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?= <${address}>`;
}

/** The address out of a configured sender, which may already carry a name. */
export function senderAddress(configured: string): string {
  const angled = /<([^>]+)>/.exec(configured);
  return (angled ? angled[1] : configured).trim();
}
