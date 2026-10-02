import { Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPrint as faPrintDuo, faPrintSlash as faPrintSlashDuo } from '@fortawesome/pro-duotone-svg-icons';
import { useAuth } from '../contexts/AuthContext';
import { PrinterProvider, usePrinter } from '../contexts/PrinterContext';
import { api } from '../lib/api';
import type { OrgRole, SwapPrinterRecord } from '../lib/api.types';
import {
  PAPER_SIZE_LABELS,
  paperSizesFor,
  type PaperSize,
} from '../lib/printing/PhomemoPrinterService';

/**
 * What every page under the shell receives.
 *
 * Pages declare this shape inline today; new consumers should import it, so
 * there is one place that says what the context carries.
 */
export interface AppShellContext {
  orgId: string;
  perms: Set<string>;
  /**
   * Roles held at this org, derived from live profile rows.
   *
   * Distinct from permissions: being a seller is something you *are* because a
   * SellerProfile exists, not something you were granted. The retired
   * `business_seller` permission conflated the two.
   */
  roles: OrgRole[];
  /** True when the org has this module turned on. Gates nav items and page sections alike. */
  isModuleEnabled: (key: string) => boolean;
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-2 rounded text-sm transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-300 hover:bg-surface-100 hover:text-white'}`;

export default function AppShell() {
  const { user, activeOrgId, setActiveOrgId, logout, isLoading } = useAuth();
  const navigate = useNavigate();

  // `/readyz`, and not under the API prefix: health probes sit at the root so
  // they do not move with the API version. It is the readiness probe rather
  // than liveness because this drives a "server unreachable" banner — an API
  // that answers while its database is gone is not something to call fine.
  const { isError: serverDown } = useQuery({
    queryKey: ['readyz'],
    queryFn: () => fetch('/readyz').then((r) => { if (!r.ok) throw new Error(); return r.json(); }),
    refetchInterval: 10_000,
    retry: false,
    staleTime: 5_000,
  });

  const activeMembership = user?.memberships.find((m) => m.orgId === activeOrgId);
  const perms = new Set(activeMembership?.permissions ?? []);
  const roles = activeMembership?.roles ?? [];

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
    // Without org data (the caller lacks org:read) assume enabled so the nav shows.
    if (!org) {
      return perms.has(`${key}:report` as never)
        || perms.has(`${key}:manage` as never)
        || perms.has(`${key}:admin` as never)
        || (key === 'ski_swap' && roles.includes('seller'));
    }
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
      isSeller={roles.includes('seller') && !perms.has('ski_swap:report')}
      canPrint={perms.has('ski_swap:manage') || roles.includes('seller')}
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
          {(perms.has('ski_swap:report') || roles.includes('seller')) && isModuleEnabled('ski_swap') && (
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
        <Outlet context={{ orgId: activeOrgId, perms, roles: activeMembership?.roles ?? [], isModuleEnabled }} />
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
  const {
    preferredPrinter, isPreferredConnected, connectPreferred, disconnectPreferred,
    setPaperSize, previewMode, setPreviewMode, isSupported,
    printCalibration, printPrinterIdLabel, printers, connectPrinterById,
  } = usePrinter();
  const [isConnecting, setIsConnecting] = useState(false);
  const [showPopover, setShowPopover] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'calibration' | 'id' | null>(null);

  if (!isSupported || !preferredPrinter) return null;

  /**
   * Reconnects, and says so when it does not.
   *
   * Every failure here used to be swallowed as "user cancelled", which is only
   * sometimes true. A picker filtered to one Bluetooth name shows an empty list
   * when nothing is advertising that name, and dismissing an empty list raises
   * the same `NotFoundError` as changing your mind — so a printer that was
   * asleep, out of range, or holding a connection to something else looked
   * exactly like a printer nobody had tried to connect to. The button span, and
   * nothing else happened.
   */
  async function handleConnect() {
    setIsConnecting(true);
    setConnectError(null);
    try {
      await connectPreferred();
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'NotFoundError') {
        // Cancelled and an empty list raise the same error, so say both.
        setConnectError(
          'No printer picked. If nothing was listed, the printer is asleep, out of range, ' +
          'or still holding a connection — switch it off and on and try again.',
        );
      } else {
        setConnectError((err as Error)?.message ?? 'Could not connect to the printer.');
      }
    } finally {
      setIsConnecting(false);
    }
  }

  /**
   * Connects to another of the org's printers, which then becomes the one this
   * browser prints to. A printer on a bridge is left out: the bridge holds its
   * Bluetooth link, so the browser could never reach it.
   */
  async function handleSwitch(printer: SwapPrinterRecord) {
    setIsConnecting(true);
    setConnectError(null);
    try {
      await connectPrinterById(printer);
      setShowPopover(false);
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      setConnectError(
        name === 'NotFoundError'
          ? `${printer.name} wasn't picked. If it wasn't listed, it's asleep, out of range, or connected to something else.`
          : (err as Error)?.message ?? `Could not connect to ${printer.name}.`,
      );
    } finally {
      setIsConnecting(false);
    }
  }
  const otherPrinters = printers.filter((p) => p.id !== preferredPrinter?.id && !p.bridgeDeviceId);

  async function handlePaperSize(size: PaperSize) {
    setShowPopover(false);
    await setPaperSize(size);
  }

  /**
   * The two labels a printer prints about itself.
   *
   * They live here rather than on the Hardware page because both need a live
   * Bluetooth link, and this menu is the only place that has one — a row on a
   * list of every printer the org owns could offer them for a printer nobody is
   * connected to, and usually did.
   */
  async function handleSelfPrint(kind: 'calibration' | 'id') {
    setBusyAction(kind);
    setConnectError(null);
    try {
      if (kind === 'calibration') await printCalibration(preferredPrinter!);
      else await printPrinterIdLabel(preferredPrinter!);
      setShowPopover(false);
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'NotFoundError') return; // picker dismissed
      setConnectError((err as Error)?.message ?? 'Could not print.');
    } finally {
      setBusyAction(null);
    }
  }


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
                {paperSizesFor(preferredPrinter.model).map((size) => (
                  <button
                    key={size}
                    onClick={() => handlePaperSize(size)}
                    className={`w-full text-left px-3 py-1.5 hover:bg-surface-200 ${preferredPrinter.paperSize === size ? 'text-brand-400' : 'text-gray-300'}`}
                  >
                    {PAPER_SIZE_LABELS[size]}{preferredPrinter.paperSize === size && ' ✓'}
                  </button>
                ))}
                <div className="border-t border-gray-800 mt-1" />
                <p className="px-3 pt-2 pb-1 text-gray-500 text-xs">Print a test</p>
                <button
                  onClick={() => { void handleSelfPrint('calibration'); }}
                  disabled={!!busyAction}
                  className="w-full text-left px-3 py-1.5 text-gray-300 hover:bg-surface-200 disabled:opacity-40"
                  title="A grid and diagonals, for checking margins and alignment"
                >
                  {busyAction === 'calibration' ? 'Printing…' : 'Calibration pattern'}
                </button>
                <button
                  onClick={() => { void handleSelfPrint('id'); }}
                  disabled={!!busyAction}
                  className="w-full text-left px-3 py-1.5 text-gray-300 hover:bg-surface-200 disabled:opacity-40"
                  title="Sticks on the printer so staff can tell one from another"
                >
                  {busyAction === 'id' ? 'Printing…' : 'Identification label'}
                </button>
                {connectError && (
                  <p className="px-3 pb-2 text-amber-400 text-xs">{connectError}</p>
                )}
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
              <>
                <button
                  onClick={() => { void handleConnect(); }}
                  disabled={isConnecting}
                  className="w-full text-left px-3 py-2 text-gray-300 hover:bg-surface-200 disabled:opacity-40"
                >
                  {isConnecting ? 'Connecting…' : `Reconnect to ${preferredPrinter.name}`}
                </button>
                {otherPrinters.length > 0 && (
                  <>
                    <div className="border-t border-gray-800" />
                    <p className="px-3 pt-2 pb-1 text-gray-500 text-xs">Connect a different printer</p>
                    {otherPrinters.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => { void handleSwitch(p); }}
                        disabled={isConnecting}
                        className="w-full text-left px-3 py-1.5 text-gray-300 hover:bg-surface-200 disabled:opacity-40"
                      >
                        {p.name}
                        <span className="text-gray-500"> · {PAPER_SIZE_LABELS[p.paperSize]}</span>
                      </button>
                    ))}
                  </>
                )}
                {connectError && (
                  <p className="px-3 pb-2 text-amber-400 text-xs">{connectError}</p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
