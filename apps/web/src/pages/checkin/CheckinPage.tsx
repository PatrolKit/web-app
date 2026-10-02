import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { CheckinShell, ErrorNote } from './shared';
import SignInStep from './SignInStep';
import NameStep from './NameStep';
import AddressStep from './AddressStep';
import PayoutStep from './PayoutStep';
import ItemsStep from './ItemsStep';
import FinishStep from './FinishStep';
import type { CheckinContext, CheckinJoined } from '../../lib/api.types';

/**
 * Self-service check-in, start to finish.
 *
 * Everything hangs off two ids in the query string, put there by the station's
 * QR code — which the iOS camera opens in a *fresh tab*, so this has to work
 * cold, unauthenticated, with no prior state. The ids are only ever a lookup
 * key: the server revalidates them against a running swap on every call, so
 * editing the address bar buys nothing.
 */
export default function CheckinPage() {
  const [params] = useSearchParams();
  const swapId = params.get('swap') ?? '';
  const stationId = params.get('station') ?? '';
  const { user, isLoading: authLoading } = useAuth();

  const { data: context, error: contextError, isLoading } = useQuery({
    queryKey: ['checkin/context', swapId, stationId],
    queryFn: () => api.checkin.context(swapId, stationId),
    enabled: !!swapId && !!stationId,
    retry: false,
    staleTime: 5 * 60_000,
  });

  if (!swapId || !stationId) {
    return (
      <CheckinShell title="Scan the code at your station">
        <ErrorNote>
          This page needs the QR code at your check-in station. Ask a volunteer if you
          cannot find it.
        </ErrorNote>
      </CheckinShell>
    );
  }

  if (isLoading || authLoading) {
    return <CheckinShell title="Check-in"><p className="text-center text-gray-400">Loading…</p></CheckinShell>;
  }

  if (contextError || !context) {
    return (
      <CheckinShell title="Check-in unavailable">
        <ErrorNote>
          {contextError instanceof ApiError ? contextError.message : 'This station is not set up right now.'}
        </ErrorNote>
      </CheckinShell>
    );
  }

  if (!user) return <SignInStep context={context} />;

  /*
   * Keyed on who is signed in, so a change of person is a fresh start.
   *
   * Everything below — joined, address, payout, finished — belongs to one
   * seller's check-in, and it used to live up here, where it survived
   * "Not you?". The next person to sign in on the same phone landed on the
   * previous one's finish screen, or on their items with the address and
   * payout steps skipped, with no profile of their own and no way back short
   * of a reload. A new key is a new component with nothing carried over.
   */
  return <SignedInCheckin key={user.id} context={context} />;
}

function SignedInCheckin({ context }: { context: CheckinContext }) {
  const [joined, setJoined] = useState<CheckinJoined | null>(null);
  /** Held here so the payout step can show it back without asking again. */
  const [address, setAddress] = useState<{
    street: string; city: string; state: string; zip: string;
  } | null>(null);
  const [payoutDone, setPayoutDone] = useState(false);
  const [namedThisSession, setNamedThisSession] = useState(false);
  const [joinError, setJoinError] = useState('');
  /**
   * Null until check-in is done; afterwards, what finishing reported. Held
   * rather than reduced to a boolean because the finish screen tells a seller
   * to wait with their items only when some of them are actually waiting, and
   * that is the only place the count is available.
   */
  const [finished, setFinished] = useState<
    { awaitingConsignment: number; emailedTo: string | null } | null
  >(null);

  // Joining is idempotent and cheap, so it runs as soon as there is a session
  // rather than behind a button — a seller returning to a half-finished
  // check-in should land straight on their items.
  useEffect(() => {
    if (joined) return;
    let cancelled = false;
    api.checkin
      .join(context.orgId, context.swapId, context.stationId)
      .then((res) => { if (!cancelled) setJoined(res); })
      .catch((err) => {
        if (!cancelled) setJoinError(err instanceof ApiError ? err.message : 'Could not check you in');
      });
    return () => { cancelled = true; };
  }, [context, joined]);

  if (joinError) {
    return (
      <CheckinShell title="Check-in" logoUrl={context.orgLogoUrl}>
        <ErrorNote>{joinError}</ErrorNote>
      </CheckinShell>
    );
  }

  if (!joined) {
    return <CheckinShell title="Check-in"><p className="text-center text-gray-400">Setting you up…</p></CheckinShell>;
  }

  if (finished) {
    return (
      <FinishStep
        context={context}
        awaitingConsignment={finished.awaitingConsignment}
        emailedTo={finished.emailedTo}
        // Which verified contact they have decides whether a copy can be sent
        // at all, and what the button is allowed to promise.
        verifiedEmail={joined.profile.verifiedEmail}
        verifiedPhone={joined.profile.verifiedPhone}
      />
    );
  }

  // Only a first-time seller sees this; everyone the roster already knows goes
  // straight past it.
  if (joined.needsName && !namedThisSession) {
    return <NameStep context={context} onDone={() => setNamedThisSession(true)} />;
  }

  // Address, then payout — both asked once per check-in, of everyone. A
  // returning seller sees their answers already filled in and confirms them,
  // which is where a moved house or a closed PayPal gets noticed.
  if (!address) {
    return (
      <AddressStep
        context={context}
        profile={joined.profile}
        onDone={setAddress}
      />
    );
  }

  if (!payoutDone) {
    return (
      <PayoutStep
        context={context}
        profile={joined.profile}
        address={address}
        onDone={() => setPayoutDone(true)}
        onEditAddress={() => setAddress(null)}
      />
    );
  }

  return <ItemsStep context={context} onFinished={setFinished} />;
}
