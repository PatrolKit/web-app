import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** The swap's issued tickets that aren't in Square: how many, and whether a push is running (Plan 38, D9). */
export const ticketPushKey = (orgId: string, swapId: string) => ['ski-swap/ticket-push', orgId, swapId];

export function useTicketPushStatus(orgId: string, swapId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ticketPushKey(orgId, swapId ?? ''),
    queryFn: () => api.skiSwap.ticketPushStatus(orgId, swapId!),
    enabled: !!swapId && enabled,
    refetchInterval: (q) => (q.state.data?.pushing ? 2000 : false),
  });
}

/**
 * Finish putting issued tickets in Square (D9): a push that stopped, on a
 * restart or a Square error, picks up whatever is still missing.
 */
export default function TicketSquareModal({ orgId, swapId, onClose }: {
  orgId: string;
  swapId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: status } = useTicketPushStatus(orgId, swapId, true);
  const start = useMutation({
    mutationFn: () => api.skiSwap.pushTickets(orgId, swapId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ticketPushKey(orgId, swapId) }),
  });
  const left = status?.notInSquare ?? 0;
  const leftText = left.toLocaleString('en-US');

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        className="bg-surface-50 border border-gray-700 rounded-lg p-5 max-w-sm w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-white font-medium">Put Tickets in Square</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-white text-lg leading-none">×</button>
        </div>

        <p className="text-sm text-gray-300">
          {!status
            ? 'Checking…'
            : !status.squareReady
              ? 'Square isn’t set up for this swap, so its tickets can’t go there yet.'
              : status.pushing
                ? `Putting tickets in Square: ${leftText} to go…`
                : left > 0
                  ? `${leftText} issued ticket${left === 1 ? ' isn’t' : 's aren’t'} in Square, so the register can’t sell ${left === 1 ? 'it' : 'them'} yet.`
                  : 'Every issued ticket is in Square.'}
        </p>

        {status?.squareReady && (
          <button
            type="button"
            autoFocus
            onClick={() => (left > 0 && !status.pushing ? start.mutate() : onClose())}
            disabled={start.isPending || status.pushing}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white py-2 rounded text-sm font-medium"
          >
            {status.pushing || start.isPending ? 'Working…' : left > 0 ? `Put ${leftText} in Square` : 'Done'}
          </button>
        )}
        {start.error && <p className="text-xs text-red-400">{start.error.message}</p>}
      </div>
    </div>
  );
}
