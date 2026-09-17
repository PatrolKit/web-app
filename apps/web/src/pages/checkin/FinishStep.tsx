import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck as faCheckDuo, faEnvelope as faEnvelopeDuo, faMessage as faMessageDuo } from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import { SELLER_SITE_URL } from '../../lib/sellerSiteUrl';
import { CheckinShell, contextLine, ErrorNote, formatCents, secondaryButtonClass } from './shared';
import type { CheckinContext, CheckinSummary } from '../../lib/api.types';

/**
 * The last screen: what to do with the items, and where to check on them later.
 *
 * The receipt is already queued at the station's printer by the time this
 * renders, so this is confirmation rather than an action.
 *
 * What it says depends on `awaitingConsignment` rather than on the org setting.
 * "Checked in" is not true yet for an item nobody has looked at — it is tagged
 * and still the seller's — and the count is the only thing that knows, because
 * an item checked in before the toggle went on does not wait.
 */
export default function FinishStep({
  context,
  awaitingConsignment,
  verifiedEmail,
  verifiedPhone,
}: {
  context: CheckinContext;
  /** How many of this seller's items still need a staff member to accept them. */
  awaitingConsignment: number;
  /** The proven contacts. Either one is somewhere a copy can be sent. */
  verifiedEmail: string | null;
  verifiedPhone: string | null;
}) {
  const { data: summary } = useQuery<CheckinSummary>({
    queryKey: ['checkin/summary', context.orgId, context.swapId],
    queryFn: () => api.checkin.summary(context.orgId, context.swapId),
  });

  const waiting = awaitingConsignment > 0;

  /*
   * A copy, if there is anywhere to send one.
   *
   * Nothing is offered when neither contact is verified: the seller cannot fix
   * that from this screen, and an explanation with no remedy is noise. Email
   * wins when both exist — it carries the receipt itself rather than a link.
   */
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sendError, setSendError] = useState('');
  const destination = verifiedEmail ?? verifiedPhone;
  const byEmail = !!verifiedEmail;

  async function sendCopy() {
    setSending(true);
    setSendError('');
    try {
      const res = await api.receipts.sendMine(context.orgId, context.swapId);
      // Only SENT means a message left. SUPPRESSED is this deployment having
      // outbound messages switched off, which a seller cannot do anything
      // about — but telling them it was sent leaves them waiting for a text
      // that is never coming, so say the true thing and point at a human.
      if (res.status === 'SENT') setSentTo(res.destination);
      else setSendError('We could not send it just now — ask a volunteer for a copy.');
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Could not send your receipt');
    } finally {
      setSending(false);
    }
  }

  return (
    <CheckinShell
      title={waiting ? "Checked in — waiting to be accepted" : "You're checked in"}
      subtitle={contextLine(context)}
      logoUrl={context.orgLogoUrl}
    >
      <div className="bg-surface-50 border border-gray-800 rounded-xl p-4 space-y-3">
        <p className="text-sm text-gray-300">
          {waiting
            ? 'Stay with your items. A volunteer will come and look through them. Your receipt is printing at this station.'
            : 'Your receipt is printing at this station. Take it with you — it lists everything you dropped off.'}
        </p>
        <ol className="text-sm text-gray-400 space-y-2 list-decimal list-inside">
          <li>Put a tag on each item.</li>
          {waiting ? (
            <li>Wait here with them — a volunteer will scan each tag.</li>
          ) : (
            <li>Hand your items to a volunteer at this station.</li>
          )}
          <li>Keep the receipt to track sales and collect payment.</li>
        </ol>
      </div>

      {destination && (
        <div className="space-y-2">
          {sentTo ? (
            <p className="flex items-center justify-center gap-2 text-sm text-green-400 py-2">
              <FontAwesomeIcon icon={faCheckDuo} />
              Sent to {sentTo}
            </p>
          ) : (
            <button
              className={`${secondaryButtonClass} flex items-center justify-center gap-2`}
              disabled={sending}
              onClick={sendCopy}
            >
              <FontAwesomeIcon icon={byEmail ? faEnvelopeDuo : faMessageDuo} />
              {sending
                ? 'Sending…'
                : byEmail
                  ? `Email my receipt to ${verifiedEmail}`
                  : 'Text me a link to my receipt'}
            </button>
          )}
          <ErrorNote>{sendError}</ErrorNote>
        </div>
      )}

      {summary && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between px-1">
            <h2 className="text-sm font-medium text-gray-300">
              {summary.items.length} item{summary.items.length === 1 ? '' : 's'}
            </h2>
            <span className="text-sm text-gray-400">{formatCents(summary.totalCents)}</span>
          </div>
          <ul className="space-y-1.5">
            {summary.items.map((item) => (
              <li key={item.id} className="bg-surface-50 border border-gray-800 rounded-lg px-3 py-2">
                <p className="text-sm text-white truncate">{item.name}</p>
                <p className="text-xs text-gray-500">{item.sku} · {formatCents(item.priceCents)}</p>
              </li>
            ))}
          </ul>

          <a
            href={`${SELLER_SITE_URL}/s/${summary.sellerId}`}
            className="block text-center text-sm text-brand-600 hover:underline py-3"
          >
            Track your items
          </a>
        </div>
      )}
    </CheckinShell>
  );
}
