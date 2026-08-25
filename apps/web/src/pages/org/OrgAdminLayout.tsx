import { NavLink, Navigate, Outlet, useOutletContext } from 'react-router-dom';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm px-3 py-1.5 rounded transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`;

export interface OrgAdminContext {
  orgId: string;
  perms: Set<string>;
}

export default function OrgAdminLayout() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();

  if (!perms.has('org:manage')) return <Navigate to="/dashboard" replace />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Org Admin</h1>

      <nav className="flex items-center gap-1 border-b border-gray-800 pb-1">
        <NavLink to="" end className={navClass}>General</NavLink>
        <NavLink to="resorts" className={navClass}>Resorts</NavLink>
      </nav>

      <Outlet context={{ orgId, perms } satisfies OrgAdminContext} />
    </div>
  );
}
