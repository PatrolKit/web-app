import { useState, useEffect } from 'react';
import { NavLink, Navigate, Outlet, useOutletContext, useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import type { SwapResponse } from '../../lib/api.types';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm px-3 py-1.5 rounded transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`;

export interface SkiSwapContext {
  orgId: string;
  perms: Set<string>;
  selectedSwap: SwapResponse | null;
  setSelectedSwapId: (id: string) => void;
  swaps: SwapResponse[];
}

export default function SkiSwapLayout() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const storageKey = user ? `patrolkit:${user.id}:${orgId}:selectedSwap` : null;
  const isAdmin = perms.has('ski_swap:admin');

  const { data: swaps = [] } = useQuery({
    queryKey: ['ski-swap/swaps', orgId],
    queryFn: () => api.skiSwap.listSwaps(orgId),
    enabled: !!orgId,
  });

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['ski-swap/status', orgId],
    queryFn: () => api.skiSwap.getStatus(orgId),
    enabled: !!orgId,
    staleTime: 30_000,
  });

  const squareConfigured = status?.squareConfigured;

  // Remove the separate admin-only config check; getStatus covers everyone
  const { data: squareConfiguredAdmin } = useQuery({
    queryKey: ['ski-swap/config-exists', orgId],
    queryFn: () => api.skiSwap.getConfig(orgId).then(() => true).catch(() => false),
    enabled: false, // replaced by getStatus
  });
  void squareConfiguredAdmin; // suppress unused warning

  // Redirect admins to config tab when Square isn't configured
  useEffect(() => {
    if (isAdmin && squareConfigured === false) {
      const base = location.pathname.replace(/\/ski-swap.*$/, '/ski-swap');
      if (!location.pathname.endsWith('/config')) {
        navigate(`${base}/config`, { replace: true });
      }
    }
  }, [isAdmin, squareConfigured, location.pathname, navigate]);

  const [selectedSwapId, setSelectedSwapIdState] = useState<string | null>(() => {
    if (!storageKey) return null;
    return localStorage.getItem(storageKey) ?? null;
  });

  function setSelectedSwapId(id: string) {
    setSelectedSwapIdState(id);
    if (storageKey) localStorage.setItem(storageKey, id);
  }

  // Default to first active swap when none is stored
  useEffect(() => {
    if (!selectedSwapId && swaps.length > 0) {
      const active = swaps.find((s) => s.active) ?? swaps[0];
      setSelectedSwapId(active.id);
    }
  }, [swaps, selectedSwapId]);

  if (!perms.has('ski_swap:report')) return <Navigate to="/dashboard" replace />;

  const selectedSwap = swaps.find((s) => s.id === selectedSwapId) ?? null;

  // Non-admins blocked entirely when Square isn't configured
  if (!statusLoading && squareConfigured === false && !isAdmin) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-white">Ski Swap</h1>
        <p className="text-gray-400 text-sm">
          The Ski Swap module is not yet configured. Contact an administrator to set it up.
        </p>
      </div>
    );
  }

  // Admins see only the config tab when Square isn't configured
  const tabsDisabled = isAdmin && squareConfigured === false;

  const disabledTabClass = 'text-sm px-3 py-1.5 rounded text-gray-600 cursor-not-allowed';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Ski Swap</h1>

      {/* Sub-navigation + swap selector in the same bar */}
      <nav className="flex items-center gap-1 border-b border-gray-800 pb-1">
        <div className="flex gap-1 flex-1">
          {tabsDisabled ? (
            <>
              <span className={disabledTabClass}>Dashboard</span>
              <span className={disabledTabClass}>Items</span>
              <span className={disabledTabClass}>Sellers</span>
              <span className={disabledTabClass}>Swaps</span>
            </>
          ) : (
            <>
              <NavLink to="" end className={navClass}>Dashboard</NavLink>
              <NavLink to="items" className={navClass}>Items</NavLink>
              {perms.has('ski_swap:report') && (
                <NavLink to="sellers" className={navClass}>Sellers</NavLink>
              )}
              {perms.has('ski_swap:admin') && (
                <NavLink to="swaps" className={navClass}>Swaps</NavLink>
              )}
            </>
          )}
          {perms.has('ski_swap:admin') && (
            <NavLink to="config" className={navClass}>
              Square Config
              {squareConfigured === false && (
                <span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-yellow-400 align-middle" />
              )}
            </NavLink>
          )}
        </div>
        {swaps.length > 0 && !location.pathname.endsWith('/config') && (
          <select
            value={selectedSwapId ?? ''}
            onChange={(e) => setSelectedSwapId(e.target.value)}
            className="bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white"
          >
            {swaps.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}{s.active ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        )}
      </nav>

      <Outlet context={{ orgId, perms, selectedSwap, setSelectedSwapId, swaps } satisfies SkiSwapContext} />
    </div>
  );
}
