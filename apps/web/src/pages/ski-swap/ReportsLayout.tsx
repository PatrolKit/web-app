import { NavLink, Outlet, Navigate, useOutletContext } from 'react-router-dom';
import type { SkiSwapContext } from './SkiSwapLayout';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm px-3 py-1.5 rounded transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`;

/**
 * Reports (Plan 48): what Square and PatrolKit disagree about, for the
 * selected swap. Sales check is the sales side; Catalog check (Plan 41's
 * diagnostics) is the catalogue side. Reading either changes nothing.
 */
export default function ReportsLayout() {
  const ctx = useOutletContext<SkiSwapContext>();
  if (!ctx.perms.has('ski_swap:report')) return <Navigate to="/dashboard/ski-swap" replace />;

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1 border-b border-gray-800 pb-1">
        <NavLink to="" end className={navClass}>Sales check</NavLink>
        <NavLink to="catalog" className={navClass}>Catalog check</NavLink>
      </nav>
      <Outlet context={ctx} />
    </div>
  );
}
