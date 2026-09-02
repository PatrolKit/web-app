import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import StationsTab from '../devices/StationsTab';
import { ProvisioningCodeCard } from '../devices/DeviceCredentials';
import BridgeEditModal from './BridgeEditModal';
import type { AddStationResult } from '../devices/AddStationForm';
import type { DeviceItem, ProvisionedDevice, SwapPrinterRecord } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';

/**
 * Check-in stations, of both kinds.
 *
 * A station is a counter: a SKU namespace, a printer, and either an iPad staff
 * work or a QR code sellers scan. Both kinds live on one page because they
 * share the org's 32-character code pool — a SKU's namespace character has to
 * identify exactly one place items were checked in.
 *
 * There is nothing here but the two tables. Hardware is not provisioned on its
 * own: an iPad with no counter cannot check anyone in, and a bridge with no
 * station has nothing to print for.
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

  // Needed only to hand a brand-new bridge to its setup screen, which asks
  // which printer it drives.
  const { data: printers = [] } = useQuery({
    queryKey: ['ski-swap/printers', orgId],
    queryFn: () => api.skiSwap.listPrinters(orgId),
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

  /**
   * A bridge that has credentials and nothing else. It goes to the same screen
   * the Printers page uses: a board that has never had Wi-Fi looks exactly like
   * a working one here, and only stops looking like one at a venue.
   */
  const [newBridge, setNewBridge] = useState<DeviceItem | null>(null);

  function handleStationAdded(result: AddStationResult) {
    if (result.newTablet) setNewTablet(result.newTablet);
    if (result.newBridge) {
      const d = result.newBridge;
      setNewBridge({
        ...d,
        lastSeenAt: null,
        printerLink: null,
        printerLinkAt: null,
        printerName: null,
        stationName: null,
        resortId: null,
        resortName: null,
      } as DeviceItem);
    }
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

      {newBridge && (
        <BridgeEditModal
          orgId={orgId}
          bridge={newBridge}
          printers={printers}
          boundPrinter={printers.find((p: SwapPrinterRecord) => p.bridgeDeviceId === newBridge.id)}
          justProvisioned
          onClose={() => setNewBridge(null)}
        />
      )}
    </div>
  );
}
