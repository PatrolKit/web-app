import { Link, NavLink, Navigate, Outlet, useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTv } from '@fortawesome/pro-duotone-svg-icons';
import { api } from '../../lib/api';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm px-3 py-1.5 rounded transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`;

export interface SignageContext {
  orgId: string;
  perms: Set<string>;
}

export default function SignageLayout() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();

  /**
   * A display is bound to a resort before it is ever switched on, and refuses
   * to be provisioned without one. With no resorts set up, the Devices tab
   * offers a form that cannot be submitted and says nothing about why.
   *
   * The same gate Time Tracking uses, for a different reason: there a resort is
   * what a shift's arithmetic is computed in, here it is where the screen
   * physically stands.
   */
  const { data: resorts, isLoading: resortsLoading } = useQuery({
    queryKey: ['resorts', orgId],
    queryFn: () => api.orgs.listResorts(orgId),
    enabled: !!orgId,
    staleTime: 60_000,
  });

  if (!perms.has('signage:report') && !perms.has('signage:manage') && !perms.has('signage:admin')) {
    return <Navigate to="/dashboard" replace />;
  }

  // Held until the answer is known: flashing "no resorts" at someone who has
  // several is worse than a moment of nothing.
  if (resortsLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Signage</h1>
        <p className="text-gray-400 text-sm">Loading…</p>
      </div>
    );
  }

  if (resorts && resorts.length === 0) {
    // Whoever can fix it is sent to where it is fixed. Resorts live under Org
    // Admin rather than in this module, so this is a link rather than a
    // redirect — bouncing someone out of the section they asked for, and
    // fighting their back button, is not worth saving them one click.
    const canManage = perms.has('org:manage');
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Signage</h1>
        <div className="bg-surface-50 border border-gray-700 rounded-lg p-6 max-w-xl space-y-3">
          <p className="text-white font-medium">No resorts set up yet</p>
          <p className="text-sm text-gray-400">
            A display is placed at a resort before it is switched on, so that what it shows
            can follow where it stands. Add one before setting up any screens.
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
      <h1 className="text-2xl font-bold text-white">Signage</h1>

      <nav className="flex items-center gap-1 border-b border-gray-800 pb-1">
        <NavLink to="" end className={navClass}>Displays</NavLink>
        {perms.has('signage:manage') && <NavLink to="devices" className={navClass}>Devices</NavLink>}
      </nav>

      <Outlet context={{ orgId, perms } satisfies SignageContext} />
    </div>
  );
}

export function SignagePlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center space-y-4">
      <FontAwesomeIcon icon={faTv} className="text-gray-600" style={{ fontSize: '5rem' }} />
      <h2 className="text-xl font-semibold text-gray-300">Coming Soon</h2>
      <p className="text-gray-500 text-sm max-w-sm">
        Publishing to displays is under construction. Screens can be set up now under Devices.
      </p>
    </div>
  );
}
