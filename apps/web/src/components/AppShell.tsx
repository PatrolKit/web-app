import { Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function AppShell() {
  const { user, activeOrgId, setActiveOrgId, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return <Navigate to="/auth/login" replace />;

  const activeMembership = user.memberships.find((m) => m.orgId === activeOrgId);
  const perms = new Set(activeMembership?.permissions ?? []);

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

        {/* Nav */}
        <nav className="flex-1 p-4 space-y-1 text-sm">
          {perms.has('users:read') && (
            <a href="/app/dashboard/members" className="block px-3 py-2 rounded hover:bg-surface-100 text-gray-300 hover:text-white">Members</a>
          )}
          {perms.has('org:read') && (
            <a href="/app/dashboard/modules" className="block px-3 py-2 rounded hover:bg-surface-100 text-gray-300 hover:text-white">Modules</a>
          )}
          {perms.has('devices:read') && (
            <a href="/app/dashboard/devices" className="block px-3 py-2 rounded hover:bg-surface-100 text-gray-300 hover:text-white">Devices</a>
          )}
          {user.isSuperAdmin && (
            <a href="/app/dashboard/admin" className="block px-3 py-2 rounded hover:bg-surface-100 text-gray-300 hover:text-white">Platform Admin</a>
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
