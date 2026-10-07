import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

function navClass({ isActive }: { isActive: boolean }): string {
  return [
    'px-3 py-1.5 rounded text-sm',
    isActive ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-gray-200',
  ].join(' ');
}

/**
 * The platform-wide view: organizations, and everyone on the platform.
 *
 * Users are their own tab rather than a section under an org, because the ones
 * worth finding here are exactly the ones no org would list — someone who
 * signed in and was never given a membership belongs to nothing, and so
 * appeared nowhere.
 *
 * Device Software belongs here for the same reason: what a signage display
 * runs is one answer for the whole platform, not a setting an org holds an
 * opinion about. So does Item Details: the shared tree an item is described
 * through is one list for everyone, and a club curates its own overlay from its
 * own Administration page rather than here. Server health, too: the limits it
 * shows are the server's, and every org shares them.
 */
export default function AdminLayout() {
  const { user } = useAuth();
  if (!user?.isSuperAdmin) return <p className="text-red-400">Access denied.</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Platform Admin</h1>

      <nav className="flex flex-wrap gap-1 border-b border-gray-800 pb-2">
        <NavLink to="/dashboard/admin" end className={navClass}>Organizations</NavLink>
        <NavLink to="/dashboard/admin/users" className={navClass}>Users</NavLink>
        <NavLink to="/dashboard/admin/device-software" className={navClass}>Device Software</NavLink>
        <NavLink to="/dashboard/admin/item-taxonomy" className={navClass}>Item Details</NavLink>
        <NavLink to="/dashboard/admin/bindings" className={navClass}>Bindings</NavLink>
        <NavLink to="/dashboard/admin/health" className={navClass}>Server health</NavLink>
        <NavLink to="/dashboard/admin/telemetry" className={navClass}>Device Telemetry</NavLink>
        <NavLink to="/dashboard/admin/configuration" className={navClass}>Configuration</NavLink>
      </nav>

      <Outlet />
    </div>
  );
}
