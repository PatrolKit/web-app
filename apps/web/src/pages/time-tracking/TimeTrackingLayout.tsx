import { Navigate, Outlet, useOutletContext } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faClock } from '@fortawesome/pro-duotone-svg-icons';

export default function TimeTrackingLayout() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();

  if (!perms.has('time_tracking:report') && !perms.has('time_tracking:manage') && !perms.has('time_tracking:admin')) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Time Tracking</h1>
      <Outlet context={{ orgId, perms }} />
    </div>
  );
}

export function TimeTrackingPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center space-y-4">
      <FontAwesomeIcon icon={faClock} className="text-gray-600" style={{ fontSize: '5rem' }} />
      <h2 className="text-xl font-semibold text-gray-300">Coming Soon</h2>
      <p className="text-gray-500 text-sm max-w-sm">
        Time Tracking is under construction. Check back soon.
      </p>
    </div>
  );
}
