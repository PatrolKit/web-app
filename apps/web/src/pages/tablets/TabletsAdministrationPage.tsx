import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import DevicePinCard from '../../components/DevicePinCard';
import type { TabletsContext } from './TabletsLayout';

/** What governs every tablet in the org: today, the PIN that guards their settings. */
export default function TabletsAdministrationPage() {
  const { orgId } = useOutletContext<TabletsContext>();

  return (
    <section className="max-w-lg">
      <DevicePinCard
        queryKey={['tablets/pin', orgId]}
        get={() => api.tablets.getPin(orgId)}
        set={(pin) => api.tablets.setPin(orgId, pin)}
        deviceLabel="tablets"
      />
    </section>
  );
}
