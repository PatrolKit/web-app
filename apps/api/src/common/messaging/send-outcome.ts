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
  | { status: 'suppressed' }
  | { status: 'failed'; error: string };
