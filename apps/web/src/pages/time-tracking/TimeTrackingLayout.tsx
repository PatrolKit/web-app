import { Link, NavLink, Navigate, Outlet, useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm px-3 py-1.5 rounded transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`;

export interface TimeTrackingContext {
  orgId: string;
  perms: Set<string>;
}

export default function TimeTrackingLayout() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();

  /**
   * Every page below needs a resort before it means anything: a shift belongs
   * to one, the hours report and shift list filter by one, and a resort is
   * where the IANA zone lives that the sweep and every shift's arithmetic are
   * computed in. With none set up, the module renders empty tables that look
   * like "nobody is on shift" rather than "this is not set up yet".
   *
   * Listing needs no permission beyond membership — the shift filters rely on
   * that — so this answers for everyone who can reach the module.
   */
  const { data: resorts, isLoading: resortsLoading } = useQuery({
    queryKey: ['resorts', orgId],
    queryFn: () => api.orgs.listResorts(orgId),
    enabled: !!orgId,
    staleTime: 60_000,
  });

  if (!perms.has('time_tracking:report') && !perms.has('time_tracking:manage') && !perms.has('time_tracking:admin')) {
    return <Navigate to="/dashboard" replace />;
  }

  // Held until the answer is known: flashing "no resorts" at someone who has
  // several is worse than a moment of nothing.
  if (resortsLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Time Tracking</h1>
        <p className="text-gray-400 text-sm">Loading…</p>
      </div>
    );
  }

  if (resorts && resorts.length === 0) {
    // Whoever can fix it is sent to where it is fixed. Resorts live under Org
    // Admin rather than in this module, so this is a link rather than the
    // redirect Ski Swap does to its own config tab — bouncing someone out of
    // the section they asked for, and fighting their back button, is not worth
    // saving them one click.
    const canManage = perms.has('org:manage');
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Time Tracking</h1>
        <div className="bg-surface-50 border border-gray-700 rounded-lg p-6 max-w-xl space-y-3">
          <p className="text-white font-medium">No resorts set up yet</p>
          <p className="text-sm text-gray-400">
            Time tracking records shifts at a resort, and uses its address to know what
            local time a shift started and when the day should be swept closed. Add one
            before patrollers start clocking in.
          </p>
          {canManage ? (
            <Link
              to="/dashboard/org-admin/resorts"
              className="inline-block bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded"
            >
              Add a resort
            </Link>
          ) : (
            <p className="text-sm text-gray-500">
              Ask an administrator to add one under Org Admin → Resorts.
            </p>
          )}
        </div>
      </div>
    );
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
