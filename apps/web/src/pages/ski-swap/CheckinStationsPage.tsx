import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import StationsTab from '../devices/StationsTab';
import { ProvisioningCodeCard } from '../devices/DeviceCredentials';
import type { AddStationResult } from '../devices/AddStationForm';
import type { ProvisionedDevice } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';

/**
 * Check-in stations, of both kinds.
 *
 * A station is a counter: a SKU namespace, a printer, and either an iPad staff
 * work or a QR code sellers scan. Both kinds live on one page because they
 * share the org's 32-character code pool — a SKU's namespace character has to
 * identify exactly one place items were checked in.
 *
 * There is nothing here but the two tables. An iPad is created with the counter
 * it serves — one bound to nothing cannot check anyone in — and a bridge is
 * only ever chosen here, never created: setting one up means holding the board
 * and sending it Wi-Fi over Bluetooth, which belongs on the Printers page.
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

  /**
   * An iPad's provisioning code, which the server returns exactly once.
   *
   * Shown here for every path that mints one — a new staff station, a
   * replacement iPad, a new code for the same iPad — because a secret nobody
   * sees is a tablet that can never be paired.
   */
  const [newTablet, setNewTablet] = useState<ProvisionedDevice | null>(null);

  function handleStationAdded(result: AddStationResult) {
    if (result.newTablet) setNewTablet(result.newTablet);
  }

  return (
    <div className="space-y-6">
      <StationsTab
        orgId={orgId}
        devices={devices}
        swapId={activeSwaps[0]?.id ?? null}
        canAdmin={canAdmin}
        onStationAdded={handleStationAdded}
      />

      {newTablet && (
        <ProvisioningCodeCard
          orgId={orgId}
          deviceId={newTablet.id}
          clientId={newTablet.clientId}
          secret={newTablet.clientSecret}
          sinceLastSeenAt={null}
          onDismiss={() => setNewTablet(null)}
        />
      )}
    </div>
  );
}
