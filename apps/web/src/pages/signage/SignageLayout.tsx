import { Navigate, Outlet, useOutletContext } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTv } from '@fortawesome/pro-duotone-svg-icons';

export default function SignageLayout() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();

  if (!perms.has('signage:report') && !perms.has('signage:manage') && !perms.has('signage:admin')) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Signage</h1>
      <Outlet context={{ orgId, perms }} />
    </div>
  );
}

export function SignagePlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center space-y-4">
      <FontAwesomeIcon icon={faTv} className="text-gray-600" style={{ fontSize: '5rem' }} />
      <h2 className="text-xl font-semibold text-gray-300">Coming Soon</h2>
      <p className="text-gray-500 text-sm max-w-sm">
        Signage management is under construction. Check back soon.
      </p>
    </div>
  );
}
