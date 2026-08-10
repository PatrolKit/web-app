import { Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-2 rounded text-sm transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-300 hover:bg-surface-100 hover:text-white'}`;

export default function AppShell() {
  const { user, activeOrgId, setActiveOrgId, logout, isLoading } = useAuth();
  const navigate = useNavigate();

  const activeMembership = user?.memberships.find((m) => m.orgId === activeOrgId);
  const perms = new Set(activeMembership?.permissions ?? []);

  // All hooks must be called before any conditional return (Rules of Hooks).
  const { data: org } = useQuery({
    queryKey: ['org', activeOrgId],
    queryFn: () => api.orgs.get(activeOrgId!),
    enabled: !!user && !!activeOrgId && perms.has('org:read'),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user) return <Navigate to="/auth/login" replace />;

  function isModuleEnabled(key: string) {
    // If org data isn't loaded (user lacks org:read), assume enabled so the nav shows.
    if (!org) return perms.has(`${key}:report` as never) || perms.has(`${key}:manage` as never) || perms.has(`${key}:admin` as never) || (key === 'ski_swap' && perms.has('business_seller'));
    return org.modules.find((m) => m.key === key)?.enabled === true;
  }

  async function handleLogout() {
    await logout();
    navigate('/auth/login', { replace: true });
  }

  return (
    <div className="min-h-screen bg-surface flex">
      {/* Sidebar */}
      <aside className="w-64 bg-surface-50 flex flex-col border-r border-gray-800">
        <div className="p-4 border-b border-gray-800">
          <span className="text-xl font-bold"><span className="text-brand-600">Patrol</span>Kit</span>
        </div>

        {/* Org switcher */}
        {user.memberships.length > 1 && (
          <div className="p-4 border-b border-gray-800">
            <select
              value={activeOrgId ?? ''}
              onChange={(e) => setActiveOrgId(e.target.value)}
              className="w-full bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white"
            >
              {user.memberships.map((m) => (
                <option key={m.orgId} value={m.orgId}>{m.orgName}</option>
              ))}
            </select>
          </div>
        )}
        {user.memberships.length === 1 && (
          <div className="p-4 text-sm text-gray-400 border-b border-gray-800 truncate">
            {activeMembership?.orgName}
          </div>
        )}

        {/* Nav — use NavLink so navigation stays in-app (no full reload) */}
        <nav className="flex-1 p-4 space-y-1">
          {perms.has('users:read') && (
            <NavLink to="members" className={navClass}>Members</NavLink>
          )}
          {perms.has('org:read') && (
            <NavLink to="modules" className={navClass}>Modules</NavLink>
          )}
          {perms.has('devices:read') && (
            <NavLink to="devices" className={navClass}>Devices</NavLink>
          )}
          {(perms.has('ski_swap:report') || perms.has('business_seller')) && isModuleEnabled('ski_swap') && (
            <NavLink
              to={perms.has('ski_swap:report') ? 'ski-swap' : 'ski-swap/my-items'}
              className={navClass}
            >Ski Swap</NavLink>
          )}
          {user.isSuperAdmin && (
            <NavLink to="admin" className={navClass}>Platform Admin</NavLink>
          )}
        </nav>

        {/* User */}
        <div className="p-4 border-t border-gray-800 text-xs text-gray-500">
          <div className="mb-1 truncate">{user.email}</div>
          <button onClick={handleLogout} className="text-brand-600 hover:underline">Sign out</button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 p-8 overflow-auto">
        <Outlet context={{ orgId: activeOrgId, perms }} />
      </main>
    </div>
  );
}
