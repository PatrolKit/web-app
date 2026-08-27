import { useOutletContext } from 'react-router-dom';
import { DeviceCredentialList } from '../devices/DeviceCredentials';
import type { DeviceRole } from '../../lib/api.types';

const TIME_CLOCK_ROLE: DeviceRole = 'time_clock.terminal';

/**
 * The tablets patrollers clock in and out on.
 *
 * Time-tracking hardware, so it lives with time tracking. The server scopes
 * these to `time_tracking:manage` by the device's own role, so a ski-swap admin
 * sees none of them.
 */
export default function TimeClockDevicesPage() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();

  return (
    <div className="space-y-4">
      <DeviceCredentialList
        orgId={orgId}
        role={TIME_CLOCK_ROLE}
        canProvision={perms.has('time_tracking:manage')}
      />
    </div>
  );
}
