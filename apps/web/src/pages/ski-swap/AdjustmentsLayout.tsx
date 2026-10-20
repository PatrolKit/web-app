import { NavLink, Outlet, Navigate, useOutletContext } from 'react-router-dom';
import type { SkiSwapContext } from './SkiSwapLayout';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm px-3 py-1.5 rounded transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`;

/**
 * Adjustments (Plan 53 D11): what changes how the selected swap's sales count.
 * Exchanges put a sale on the item that went out (Plan 49); comps mark an
 * item sold that Square has no sale for (Plan 53).
 */
export default function AdjustmentsLayout() {
  const ctx = useOutletContext<SkiSwapContext>();
  if (!ctx.perms.has('ski_swap:report')) return <Navigate to="/dashboard/ski-swap" replace />;

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1 border-b border-gray-800 pb-1">
        <NavLink to="" end className={navClass}>Exchanges</NavLink>
        <NavLink to="comps" className={navClass}>Comps</NavLink>
      </nav>
      <Outlet context={ctx} />
    </div>
  );
}
