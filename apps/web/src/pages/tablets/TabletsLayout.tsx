import { NavLink, Navigate, Outlet, useOutletContext } from 'react-router-dom';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm px-3 py-1.5 rounded transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`;

export interface TabletsContext {
  orgId: string;
  perms: Set<string>;
}

/**
 * Tablets (Plan 56): the org's iPads, and what governs all of them. Org
 * administrators only, as the main nav item is.
 */
export default function TabletsLayout() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();

  if (!perms.has('org:manage')) return <Navigate to="/dashboard" replace />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Tablets</h1>
        <p className="text-sm text-gray-400 mt-1 max-w-2xl">
          The organization’s iPads. Each runs Ski Swap or Time Clock, chosen on the iPad behind the tablet PIN.
          Put one at a check-in station on Ski Swap → Check-in; a Time Clock iPad picks its resort itself.
        </p>
      </div>

      <nav className="flex items-center gap-1 border-b border-gray-800 pb-1">
        <NavLink to="" end className={navClass}>Tablets</NavLink>
        <NavLink to="administration" className={navClass}>Administration</NavLink>
      </nav>

      <Outlet context={{ orgId, perms } satisfies TabletsContext} />
    </div>
  );
}
