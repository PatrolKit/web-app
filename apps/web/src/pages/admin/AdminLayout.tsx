import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

function navClass({ isActive }: { isActive: boolean }): string {
  return [
    'px-3 py-1.5 rounded text-sm',
    isActive ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-gray-200',
  ].join(' ');
}

/**
 * The platform-wide view: organisations, and everyone on the platform.
 *
 * Users are their own tab rather than a section under an org, because the ones
 * worth finding here are exactly the ones no org would list — someone who
 * signed in and was never given a membership belongs to nothing, and so
 * appeared nowhere.
 *
 * Device Software belongs here for the same reason: what a signage display
 * runs is one answer for the whole platform, not a setting an org holds an
 * opinion about.
 */
export default function AdminLayout() {
  const { user } = useAuth();
  if (!user?.isSuperAdmin) return <p className="text-red-400">Access denied.</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Platform Admin</h1>

      <nav className="flex gap-1 border-b border-gray-800 pb-2">
        <NavLink to="/dashboard/admin" end className={navClass}>Organizations</NavLink>
        <NavLink to="/dashboard/admin/users" className={navClass}>Users</NavLink>
        <NavLink to="/dashboard/admin/device-software" className={navClass}>Device Software</NavLink>
      </nav>

      <Outlet />
    </div>
  );
}
