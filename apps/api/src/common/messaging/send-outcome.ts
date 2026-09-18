/**
 * What a send attempt actually did.
 *
 * `MailService` and `SmsService` used to return `void`, which cannot tell three
 * cases apart that a caller has to distinguish: the message went, the message
 * was deliberately not sent because `OUTBOUND_NOTIFICATIONS` is off, and the
 * provider refused it. Without the middle one a staging box records a delivery
 * that never happened and reports it back as though it had.
 *
 * Callers that do not care keep ignoring the return.
 */
export type SendOutcome =
  | { status: 'sent'; providerRef?: string }
  /**
   * Nothing was sent, on purpose. `reason` says which purpose.
   *
   * There is more than one, and they have different lifetimes: a deployment
   * with outbound messaging switched off is a setting somebody can change,
   * while SMS with no origination number is the whole product waiting on a
   * toll-free registration. A record that says only "suppressed" cannot tell
   * support which of those it is looking at.
   */
  | { status: 'suppressed'; reason?: string }
  | { status: 'failed'; error: string };
