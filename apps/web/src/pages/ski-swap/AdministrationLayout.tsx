import { NavLink, Outlet, Navigate, useOutletContext } from 'react-router-dom';
import type { SkiSwapContext } from './SkiSwapLayout';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm px-3 py-1.5 rounded transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`;

/**
 * Splits Administration in two.
 *
 * Settings is a column of switches a person sets once and rarely opens again.
 * Item details is a working queue — values sellers typed at the counter, waiting
 * to be approved, merged or thrown away — and it grows as a swap runs. Reading
 * them as one scroll meant the queue sat above the Square credentials and the
 * delete-everything button, so a routine bit of tidying happened in the same
 * breath as the settings nobody should touch twice.
 */
export default function AdministrationLayout() {
  const ctx = useOutletContext<SkiSwapContext>();

  // Both children are admin-only, so the check belongs here rather than twice.
  if (!ctx.perms.has('ski_swap:admin')) return <Navigate to="/dashboard/ski-swap" replace />;

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1 border-b border-gray-800 pb-1">
        <NavLink to="" end className={navClass}>Settings</NavLink>
        <NavLink to="item-details" className={navClass}>Item details</NavLink>
      </nav>

      <Outlet context={ctx} />
    </div>
  );
}
