import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import StationsTab from '../devices/StationsTab';
import type { SkiSwapContext } from './SkiSwapLayout';

/**
 * Check-in stations, of both kinds.
 *
 * A station is a counter: a SKU namespace, a printer, and either a tablet staff
 * work or a QR code sellers scan. Both kinds live on one page because they
 * share the org's 32-character code pool — a SKU's namespace character has to
 * identify exactly one place items were checked in.
 *
 * Nothing is created here but stations. A staffed station takes one of the
 * org's tablets, which org administrators add on Tablets (Plan 56). A bridge is
 * only ever chosen here, never created: setting one up means holding the board
 * and sending it Wi-Fi over Bluetooth, which belongs on the Hardware page.
 */
export default function CheckinStationsPage() {
  const { orgId, perms } = useOutletContext<SkiSwapContext>();
  const canAdmin = perms.has('ski_swap:admin');

  const { data: devices = [] } = useQuery({
    queryKey: ['devices', orgId],
    queryFn: () => api.devices.list(orgId),
    enabled: !!orgId,
  });

  // Stations outlive any one swap; the QR needs whichever is running.
  const { data: activeSwaps = [] } = useQuery({
    queryKey: ['ski-swap/swaps', orgId, 'active'],
    queryFn: () => api.skiSwap.listSwaps(orgId, true),
    enabled: !!orgId,
    staleTime: 60_000,
  });

  return (
    <div className="space-y-6">
      <StationsTab
        orgId={orgId}
        devices={devices}
        swapId={activeSwaps[0]?.id ?? null}
        canAdmin={canAdmin}
        canManageTablets={perms.has('org:manage')}
      />
    </div>
  );
}
