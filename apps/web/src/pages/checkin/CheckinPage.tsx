import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { CheckinShell, ErrorNote } from './shared';
import SignInStep from './SignInStep';
import ItemsStep from './ItemsStep';
import FinishStep from './FinishStep';
import type { CheckinContext } from '../../lib/api.types';

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

  const [joined, setJoined] = useState<(CheckinContext & { sellerId: string }) | null>(null);
  const [joinError, setJoinError] = useState('');
  const [finished, setFinished] = useState(false);

  const { data: context, error: contextError, isLoading } = useQuery({
    queryKey: ['checkin/context', swapId, stationId],
    queryFn: () => api.checkin.context(swapId, stationId),
    enabled: !!swapId && !!stationId,
    retry: false,
    staleTime: 5 * 60_000,
  });

  // Joining is idempotent and cheap, so it runs as soon as there is a session
  // rather than behind a button — a seller returning to a half-finished
  // check-in should land straight on their items.
  useEffect(() => {
    if (!user || !context || joined) return;
    let cancelled = false;
    api.checkin
      .join(context.orgId, context.swapId, context.stationId)
      .then((res) => { if (!cancelled) setJoined(res); })
      .catch((err) => {
        if (!cancelled) setJoinError(err instanceof ApiError ? err.message : 'Could not check you in');
      });
    return () => { cancelled = true; };
  }, [user, context, joined]);

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

  if (finished) return <FinishStep context={context} />;

  return <ItemsStep context={context} onFinished={() => setFinished(true)} />;
}
