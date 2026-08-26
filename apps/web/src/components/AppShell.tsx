import { Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPrint as faPrintDuo, faPrintSlash as faPrintSlashDuo } from '@fortawesome/pro-duotone-svg-icons';
import { useAuth } from '../contexts/AuthContext';
import { PrinterProvider, usePrinter } from '../contexts/PrinterContext';
import { api } from '../lib/api';

/**
 * What every page under the shell receives.
 *
 * Pages declare this shape inline today; new consumers should import it, so
 * there is one place that says what the context carries.
 */
export interface AppShellContext {
  orgId: string;
  perms: Set<string>;
  /** True when the org has this module turned on. Gates nav items and page sections alike. */
  isModuleEnabled: (key: string) => boolean;
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-2 rounded text-sm transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-300 hover:bg-surface-100 hover:text-white'}`;

export default function AppShell() {
  const { user, activeOrgId, setActiveOrgId, logout, isLoading } = useAuth();
  const navigate = useNavigate();

  const { isError: serverDown } = useQuery({
    queryKey: ['healthz'],
    queryFn: () => fetch('/api/v1/healthz').then((r) => { if (!r.ok) throw new Error(); return r.json(); }),
    refetchInterval: 10_000,
    retry: false,
    staleTime: 5_000,
  });

  const activeMembership = user?.memberships.find((m) => m.orgId === activeOrgId);
  const perms = new Set(activeMembership?.permissions ?? []);

  // All hooks must be called before any conditional return (Rules of Hooks).
  const { data: org } = useQuery({
    queryKey: ['org', activeOrgId],
    queryFn: () => api.orgs.get(activeOrgId!),
    enabled: !!user && !!activeOrgId && perms.has('org:read'),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user) return <Navigate to="/auth/login" replace />;

  function isModuleEnabled(key: string) {
    // If org data isn't loaded (user lacks org:read), assume enabled so the nav shows.
    if (!org) return perms.has(`${key}:report` as never) || perms.has(`${key}:manage` as never) || perms.has(`${key}:admin` as never) || (key === 'ski_swap' && perms.has('business_seller'));
    return org.modules.find((m) => m.key === key)?.enabled === true;
  }

  async function handleLogout() {
    await logout();
    navigate('/auth/login', { replace: true });
  }

  return (
    <PrinterProvider
      orgId={activeOrgId ?? ''}
      userId={user?.id ?? ''}
      isSeller={perms.has('business_seller') && !perms.has('ski_swap:report')}
      canPrint={perms.has('ski_swap:manage') || perms.has('business_seller')}
    >
    <div className="min-h-screen bg-surface flex">
      {serverDown && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-red-950 border-b border-red-800 text-red-300 text-xs text-center py-1.5">
          Server unreachable — data shown may be stale
        </div>
      )}
      {/* Sidebar */}
      <aside className="w-64 bg-surface-50 flex flex-col border-r border-gray-800 h-screen sticky top-0 shrink-0">
        <div className="p-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="PatrolKit" className="w-8 h-8 rounded-sm" />
            <span className="text-xl font-bold"><span className="text-brand-600">Patrol</span>Kit</span>
          </div>
        </div>

        {/* Org switcher */}
        {user.memberships.length > 1 && (
          <div className="p-4 border-b border-gray-800">
            <select
              value={activeOrgId ?? ''}
              onChange={(e) => setActiveOrgId(e.target.value)}
              className="w-full bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white"
            >
              {user.memberships.map((m) => (
                <option key={m.orgId} value={m.orgId}>{m.orgName}</option>
              ))}
            </select>
          </div>
        )}
        {user.memberships.length === 1 && (
          <div className="p-4 text-sm text-gray-400 border-b border-gray-800 truncate">
            {activeMembership?.orgName}
          </div>
        )}

        {/* Nav — use NavLink so navigation stays in-app (no full reload) */}
        <nav className="flex-1 p-4 space-y-1">
          {perms.has('devices:read') && (
            <NavLink to="devices" className={navClass}>Devices</NavLink>
          )}
          {perms.has('users:read') && (
            <NavLink to="members" className={navClass}>Members</NavLink>
          )}
          {perms.has('org:manage') && (
            <NavLink to="org-admin" className={navClass}>Org Admin</NavLink>
          )}
          {user.isSuperAdmin && (
            <NavLink to="admin" className={navClass}>Platform Admin</NavLink>
          )}
          {perms.has('signage:report') && isModuleEnabled('signage') && (
            <NavLink to="signage" className={navClass}>Signage</NavLink>
          )}
          {(perms.has('ski_swap:report') || perms.has('business_seller')) && isModuleEnabled('ski_swap') && (
            <NavLink
              to={perms.has('ski_swap:report') ? 'ski-swap' : 'ski-swap/my-items'}
              className={navClass}
            >Ski Swap</NavLink>
          )}
          {perms.has('time_tracking:report') && isModuleEnabled('time_tracking') && (
            <NavLink to="time-tracking" className={navClass}>Time Tracking</NavLink>
          )}
        </nav>

        {/* User */}
        <div className="p-4 border-t border-gray-800 text-xs text-gray-500">
          <PrinterStatusBar />
          <div className="mb-1 truncate">{user.email}</div>
          <button onClick={handleLogout} className="text-brand-600 hover:underline">Sign out</button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 p-8 overflow-auto">
        {/* `isModuleEnabled` travels with the context so a page gates its own
            sections the same way the nav does — one definition of "enabled",
            including the fallback for a user who cannot read the org. */}
        <Outlet context={{ orgId: activeOrgId, perms, isModuleEnabled }} />
      </main>
      <PrintPreviewModal />
    </div>
    </PrinterProvider>
  );
}

function PrintPreviewModal() {
  const { pendingPreview, clearPendingPreview, pendingPreviews, clearPendingPreviews } = usePrinter();
  const multiPage = pendingPreviews.length > 0;
  if (!multiPage && !pendingPreview) return null;

  function handleClose() {
    if (multiPage) clearPendingPreviews();
    else clearPendingPreview();
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={handleClose}>
      <div className="bg-surface-200 rounded-lg p-4 space-y-3 max-w-xl w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-white font-semibold text-sm">Print Preview</h2>
          <button onClick={handleClose} className="text-gray-500 hover:text-white text-xs">✕ Close</button>
        </div>
        {multiPage ? (
          <div className="space-y-3 max-h-[70vh] overflow-y-auto">
            {pendingPreviews.map((src, i) => (
              <div key={i} className="bg-gray-100 rounded p-3 flex flex-col items-center gap-1">
                <span className="text-gray-500 text-xs">Page {i + 1} of {pendingPreviews.length}</span>
                <img src={src} alt={`Label page ${i + 1}`} style={{ imageRendering: 'pixelated' }} className="max-w-full" />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex justify-center bg-gray-100 rounded p-3">
            <img src={pendingPreview!} alt="Label preview" style={{ imageRendering: 'pixelated' }} className="max-w-full" />
          </div>
        )}
        <p className="text-gray-500 text-xs text-center">Preview only — not sent to printer</p>
      </div>
    </div>
  );
}

function PrinterStatusBar() {
  const { preferredPrinter, isPreferredConnected, connectPreferred, disconnectPreferred, setPaperSize, previewMode, setPreviewMode, isSupported } = usePrinter();
  const [isConnecting, setIsConnecting] = useState(false);
  const [showPopover, setShowPopover] = useState(false);

  if (!isSupported || !preferredPrinter) return null;

  async function handleConnect() {
    setIsConnecting(true);
    try { await connectPreferred(); } catch { /* user cancelled */ } finally { setIsConnecting(false); }
  }

  async function handlePaperSize(size: '40x30' | '50x30') {
    setShowPopover(false);
    await setPaperSize(size);
  }

  const PAPER_LABELS: Record<'40x30' | '50x30', string> = { '40x30': '40 × 30 mm', '50x30': '50 × 30 mm' };

  return (
    <div className="relative mb-2 pb-2 border-b border-gray-800">
      <div className="flex items-center gap-1.5 text-xs">
        <button
          onClick={() => setShowPopover((v) => !v)}
          className="flex items-center gap-1.5 min-w-0 flex-1 hover:opacity-80"
          title="Printer options"
        >
          {isConnecting
            ? <span className="w-3 h-3 border border-gray-500 border-t-transparent rounded-full animate-spin shrink-0" />
            : isPreferredConnected
              ? <FontAwesomeIcon icon={faPrintDuo} className="shrink-0 text-green-500" />
              : <FontAwesomeIcon icon={faPrintSlashDuo} className="shrink-0 text-red-600" />}
          <span className={`truncate text-left min-w-0 ${isPreferredConnected ? 'text-gray-400' : 'text-gray-500'}`}>
            {isConnecting ? 'Connecting…' : preferredPrinter.name}
          </span>
        </button>
      </div>

      {showPopover && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowPopover(false)} />
          <div className="absolute bottom-full left-0 right-0 mb-1 bg-surface-100 border border-gray-700 rounded shadow-lg z-50 overflow-hidden text-xs">
            {isPreferredConnected ? (
              <>
                <p className="px-3 pt-2 pb-1 text-gray-500 text-xs">Paper size</p>
                {(['40x30', '50x30'] as const).map((size) => (
                  <button
                    key={size}
                    onClick={() => handlePaperSize(size)}
                    className={`w-full text-left px-3 py-1.5 hover:bg-surface-200 ${preferredPrinter.paperSize === size ? 'text-brand-400' : 'text-gray-300'}`}
                  >
                    {PAPER_LABELS[size]}{preferredPrinter.paperSize === size && ' ✓'}
                  </button>
                ))}
                <div className="border-t border-gray-800 mt-1" />
                <button
                  onClick={() => { setPreviewMode(!previewMode); setShowPopover(false); }}
                  className="w-full text-left px-3 py-2 text-gray-300 hover:bg-surface-200 flex items-center justify-between"
                >
                  <span>Preview mode</span>
                  {previewMode && <span className="text-brand-400 text-xs">ON</span>}
                </button>
                <div className="border-t border-gray-800" />
                <button
                  onClick={() => { disconnectPreferred(); setShowPopover(false); }}
                  className="w-full text-left px-3 py-2 text-red-500 hover:bg-surface-200"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                onClick={() => { handleConnect(); setShowPopover(false); }}
                disabled={isConnecting}
                className="w-full text-left px-3 py-2 text-gray-300 hover:bg-surface-200 disabled:opacity-40"
              >
                Reconnect
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
