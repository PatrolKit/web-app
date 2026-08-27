import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import StationsTab from '../devices/StationsTab';
import { DeviceCredentialList } from '../devices/DeviceCredentials';
import type { DeviceRole } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';

/**
 * Only tablets are managed here. A bridge lives with the printer it drives, on
 * the Printers page — a station reaches its printer through its bridge.
 */
const STATION_ROLE: DeviceRole = 'ski_swap.staff_check_in';

/**
 * Check-in stations and the hardware that serves them.
 *
 * A station is a counter: a SKU namespace, a printer, and either a staff tablet
 * or a bridge driving it. Both kinds live here because they are the same thing —
 * they already share the org's 32-character code pool, since a SKU's namespace
 * character has to identify exactly one place items were checked in.
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
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="text-white font-medium">Check-in stations</h2>
          <p className="text-xs text-gray-500">
            Where sellers check in. A station owns the one-character code that appears in
            every SKU printed there, and reaches its printer through the bridge bound to
            it. Bind a staff tablet and it becomes a staffed counter; leave it without one
            and sellers scan its QR code themselves.
          </p>
        </div>
        <StationsTab
          orgId={orgId}
          devices={devices}
          swapId={activeSwaps[0]?.id ?? null}
          canAdmin={canAdmin}
        />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-white font-medium">Staff tablets</h2>
          <p className="text-xs text-gray-500">
            Tablets provisioned for this org. Bind one to a station above to put it to work —
            until then it holds credentials and nothing else. Bridges live on the Printers
            page, with the printer each one drives.
          </p>
        </div>
        <DeviceCredentialList
          orgId={orgId}
          role={STATION_ROLE}
          canProvision={canAdmin}
        />
      </section>
    </div>
  );
}
