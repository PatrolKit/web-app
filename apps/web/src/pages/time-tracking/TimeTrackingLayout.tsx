import { NavLink, Navigate, Outlet, useOutletContext } from 'react-router-dom';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm px-3 py-1.5 rounded transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`;

export interface TimeTrackingContext {
  orgId: string;
  perms: Set<string>;
}

export default function TimeTrackingLayout() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();

  if (!perms.has('time_tracking:report') && !perms.has('time_tracking:manage') && !perms.has('time_tracking:admin')) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Time Tracking</h1>

      <nav className="flex items-center gap-1 border-b border-gray-800 pb-1">
        <NavLink to="" end className={navClass}>On Shift</NavLink>
        <NavLink to="shifts" className={navClass}>Shifts</NavLink>
        <NavLink to="hours" className={navClass}>Hours</NavLink>
        <span className="mx-2 text-gray-700 select-none">|</span>
        {perms.has('time_tracking:manage') && <NavLink to="roster" className={navClass}>Roster</NavLink>}
        {perms.has('time_tracking:manage') && <NavLink to="devices" className={navClass}>Devices</NavLink>}
        {perms.has('time_tracking:admin') && <NavLink to="settings" className={navClass}>Settings</NavLink>}
      </nav>

      <Outlet context={{ orgId, perms } satisfies TimeTrackingContext} />
    </div>
  );
}
