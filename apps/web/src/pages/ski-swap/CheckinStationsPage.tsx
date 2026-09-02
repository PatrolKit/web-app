import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import StationsTab from '../devices/StationsTab';
import { DeviceCredentialList, ProvisioningCodeCard } from '../devices/DeviceCredentials';
import BridgeEditModal from './BridgeEditModal';
import type { AddStationResult } from '../devices/AddStationFlow';
import type { DeviceItem, DeviceRole, ProvisionedDevice, SwapPrinterRecord } from '../../lib/api.types';
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

  // Needed only to hand a brand-new bridge to its setup screen, which asks
  // which printer it drives.
  const { data: printers = [] } = useQuery({
    queryKey: ['ski-swap/printers', orgId],
    queryFn: () => api.skiSwap.listPrinters(orgId),
    enabled: !!orgId,
    staleTime: 60_000,
  });

  /**
   * A bridge provisioned inside the station flow, which has credentials and
   * nothing else.
   *
   * It goes to the same screen the Printers page uses, rather than being left
   * bound and unconfigured: a board that has never had Wi-Fi looks exactly like
   * a working one on this page, and only stops looking like one at a venue.
   */
  const [newBridge, setNewBridge] = useState<DeviceItem | null>(null);

  /**
   * A tablet provisioned inside the station flow, and its one-time secret.
   *
   * Held here because the server shows a client secret exactly once: the list
   * below only reveals secrets it minted itself, so a tablet created by the
   * flow would otherwise be issued credentials nobody ever saw and be
   * unprovisionable without a rotation.
   */
  const [newTablet, setNewTablet] = useState<ProvisionedDevice | null>(null);

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
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="text-white font-medium">Check-in stations</h2>
          <p className="text-xs text-gray-500">
            Where sellers check in. A station owns the one-character code that appears in
            every SKU printed there, and reaches its printer through the bridge bound to it.
          </p>
        </div>
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
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-white font-medium">Tablet credentials</h2>
          <p className="text-xs text-gray-500">
            Every staff tablet in this org, wherever it is stationed — this is where a
            secret is rotated or a lost tablet revoked. Tablets are normally set up with
            their station above; one listed here with no station is waiting to be given
            one. Bridges live on the Printers page, with the printer each one drives.
          </p>
        </div>
        <DeviceCredentialList
          orgId={orgId}
          role={STATION_ROLE}
          canProvision={canAdmin}
        />
      </section>

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
