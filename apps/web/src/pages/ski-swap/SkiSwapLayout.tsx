import { useState, useEffect } from 'react';
import { NavLink, Navigate, Outlet, useOutletContext, useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { AppShellContext } from '../../components/AppShell';
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
  sellerSelectedSwapId: string | null;
  setSellerSelectedSwapId: (id: string) => void;
  sellerSwaps: { id: string; title: string }[];
  labelsPerItem: number;
  /** Whether self check-in items wait for a staff member to scan them. */
  requireConsignmentScan: boolean;
}

export default function SkiSwapLayout() {
  const { orgId, perms, roles } = useOutletContext<AppShellContext>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const storageKey = user ? `patrolkit:${user.id}:${orgId}:selectedSwap` : null;
  const sellerStorageKey = user ? `patrolkit:${user.id}:${orgId}:sellerSelectedSwap` : null;
  const isAdmin = perms.has('ski_swap:admin');
  // Being a seller is a role derived from a live profile row, not a permission —
  // `business_seller` was retired with the identity consolidation in Plan 10.
  const isSellerOnly = roles.includes('seller') && !perms.has('ski_swap:report');

  const { data: swaps = [] } = useQuery({
    queryKey: ['ski-swap/swaps', orgId],
    queryFn: () => api.skiSwap.listSwaps(orgId, true),
    enabled: !!orgId && perms.has('ski_swap:report'),
  });

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['ski-swap/status', orgId],
    queryFn: () => api.skiSwap.getStatus(orgId),
    enabled: !!orgId && perms.has('ski_swap:report'),
    staleTime: 30_000,
  });

  const { data: skiSwapSettings } = useQuery({
    queryKey: ['ski-swap/settings', orgId],
    queryFn: () => api.skiSwap.getSettings(orgId),
    enabled: !!orgId && perms.has('ski_swap:report'),
    staleTime: 60_000,
  });
  const labelsPerItem = skiSwapSettings?.labelsPerItem ?? 1;
  const requireConsignmentScan = skiSwapSettings?.requireConsignmentScan ?? false;

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
      // Anywhere under config counts as already there — Administration has
      // subtabs now, and matching only the exact path bounced a person off
      // Item details and back to Settings.
      if (!/\/config(\/|$)/.test(location.pathname)) {
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

  // Default to first swap when nothing is stored
  useEffect(() => {
    if (!selectedSwapId && swaps.length > 0) {
      setSelectedSwapId(swaps[0].id);
    }
  }, [swaps, selectedSwapId]);

  // ─── Seller swap state (business_seller users) ────────────────────────────
  const { data: sellerSwaps = [] } = useQuery({
    queryKey: ['seller/swaps', orgId],
    queryFn: () => api.skiSwap.sellerListSwaps(orgId),
    enabled: !!orgId && isSellerOnly,
  });

  const [sellerSelectedSwapId, setSellerSelectedSwapIdState] = useState<string | null>(() =>
    sellerStorageKey ? (localStorage.getItem(sellerStorageKey) ?? null) : null
  );
  function setSellerSelectedSwapId(id: string) {
    setSellerSelectedSwapIdState(id);
    if (sellerStorageKey) localStorage.setItem(sellerStorageKey, id);
  }
  useEffect(() => {
    if (!sellerSelectedSwapId && sellerSwaps.length > 0) setSellerSelectedSwapId(sellerSwaps[0].id);
  }, [sellerSwaps, sellerSelectedSwapId]);

  if (!perms.has('ski_swap:report') && !roles.includes('seller')) return <Navigate to="/dashboard" replace />;

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

  // Swap-scoped routes show the picker; org-scoped routes don't. Config matches
  // its subtabs too — Item details is the org's taxonomy, the same tree whichever
  // swap is selected, so offering a swap to pick would be offering a choice that
  // changes nothing.
  const isSwapScopedTab = !location.pathname.match(
    /\/(sellers|swaps|my-items|seller-profile)$|\/config(\/|$)/,
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Ski Swap</h1>

      {/* Nav bar: swap-scoped tabs | org-scoped tabs, with swap picker on the right for swap tabs */}
      <nav className="flex items-center gap-1 border-b border-gray-800 pb-1">
        <div className="flex items-center gap-1 flex-1">
          {/* Swap-scoped group */}
          {tabsDisabled ? (
            <>
              <span className={disabledTabClass}>Dashboard</span>
              <span className={disabledTabClass}>Items</span>
            </>
          ) : (
            <>
              {perms.has('ski_swap:report') && <NavLink to="" end className={navClass}>Dashboard</NavLink>}
              {perms.has('ski_swap:report') && <NavLink to="items" className={navClass}>Items</NavLink>}
              {isSellerOnly && <NavLink to="my-items" className={navClass}>My Items</NavLink>}
              {isSellerOnly && <NavLink to="seller-profile" className={navClass}>Seller Profile</NavLink>}
            </>
          )}

          {/* Divider */}
          <span className="mx-2 text-gray-700 select-none">|</span>

          {/* Org-scoped group */}
          {tabsDisabled ? (
            <>
              <span className={disabledTabClass}>Sellers</span>
              <span className={disabledTabClass}>Swaps</span>
            </>
          ) : (
            <>
              {perms.has('ski_swap:report') && (
                <NavLink to="sellers" className={navClass}>Sellers</NavLink>
              )}
              {perms.has('ski_swap:admin') && (
                <NavLink to="swaps" className={navClass}>Swaps</NavLink>
              )}
            </>
          )}
          {perms.has('ski_swap:report') && (
            <NavLink to="check-in" className={navClass}>Check-in</NavLink>
          )}
          {/* The route stays /printers: the page has held bridges as well as
              printers for a while, and now scanners too, so only the label was
              ever wrong. Renaming the path would break saved links for nothing. */}
          {perms.has('ski_swap:admin') && (
            <NavLink to="printers" className={navClass}>Hardware</NavLink>
          )}
          {perms.has('ski_swap:admin') && (
            <NavLink to="config" className={navClass}>
              Administration
              {squareConfigured === false && (
                <span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-yellow-400 align-middle" />
              )}
            </NavLink>
          )}
        </div>

        {/* Manager swap picker — shown on swap-scoped tabs */}
        {isSwapScopedTab && swaps.length > 0 && (
          <select
            value={selectedSwapId ?? ''}
            onChange={(e) => setSelectedSwapId(e.target.value)}
            className="bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white"
          >
            {swaps.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </select>
        )}
        {/* Seller swap picker — shown on my-items only */}
        {isSellerOnly && location.pathname.endsWith('/my-items') && (
          <select
            value={sellerSelectedSwapId ?? ''}
            onChange={(e) => setSellerSelectedSwapId(e.target.value)}
            className="bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white"
          >
            {sellerSwaps.length === 0
              ? <option value="">No active swaps</option>
              : sellerSwaps.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        )}
      </nav>

      <Outlet context={{ orgId, perms, selectedSwap, setSelectedSwapId, swaps, sellerSelectedSwapId, setSellerSelectedSwapId, sellerSwaps, labelsPerItem, requireConsignmentScan } satisfies SkiSwapContext} />
    </div>
  );
}
