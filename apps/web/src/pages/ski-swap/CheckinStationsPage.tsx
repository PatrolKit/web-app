import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import StationsTab from '../devices/StationsTab';
import { DeviceCredentialList } from '../devices/DeviceCredentials';
import type { DeviceRole } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';

/** The hardware a check-in station is built from. */
const STATION_ROLES: readonly DeviceRole[] = ['ski_swap.staff_check_in', 'ski_swap.print_bridge'];

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

  const { data: printers = [] } = useQuery({
    queryKey: ['ski-swap/printers', orgId],
    queryFn: () => api.skiSwap.listPrinters(orgId),
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
      <StationsTab
        orgId={orgId}
        devices={devices}
        printers={printers}
        swapId={activeSwaps[0]?.id ?? null}
        canAdmin={canAdmin}
      />

      <section className="space-y-3">
        <div>
          <h2 className="text-white font-medium">Check-in hardware</h2>
          <p className="text-xs text-gray-500">
            Tablets and bridges provisioned for this org. Bind one to a station above to put
            it to work — until then it holds credentials and nothing else.
          </p>
        </div>
        <DeviceCredentialList
          orgId={orgId}
          roles={STATION_ROLES}
          printers={printers}
          canProvision={canAdmin}
        />
      </section>
    </div>
  );
}
