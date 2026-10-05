import { useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleCheck as faCircleCheckDuo, faCircleXmark as faCircleXmarkDuo,
  faScannerGun as faScannerGunDuo, faTriangleExclamation as faTriangleExclamationDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import type { SellerResponse } from '../../lib/api.types';
import { useScanner } from '../../contexts/ScannerContext';
import { useTicketPushStatus } from './TicketSquareModal';
import {
  checked, emptyBatch, markedTaken, removed, scanned, toSave, uncheckable, type BatchState,
} from './batchAddLogic';

/** A short, low double beep for a refused scan (D7). Made here; no sound file. */
function errorTone() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.18].forEach((at) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 220;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.15);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch { /* no audio: the red message still says it */ }
}

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Batch add to seller (Plan 40): pick a seller, scan a stack of legacy tickets,
 * and save them all as that seller's items, on sale with no price, as the
 * iPad's batch check-in does. Bad scans are refused on the spot (D7).
 */
export default function BatchAddTicketsModal({ orgId, swapId, sellers, onClose, onSaved }: {
  orgId: string;
  swapId: string;
  sellers: SellerResponse[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const scanner = useScanner();
  const [seller, setSeller] = useState<SellerResponse | null>(null);
  const [search, setSearch] = useState('');
  const [state, setState] = useState<BatchState>(emptyBatch);
  const stateRef = useRef(state);
  const [typed, setTyped] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  // One key per batch, so a Save retried after a dropped answer adds nothing twice.
  const keyRef = useRef(idempotencyKey());

  const commit = (next: BatchState) => {
    if (next.rejection && next.rejection !== stateRef.current.rejection) errorTone();
    stateRef.current = next;
    setState(next);
  };

  /** A scan or a typed number: checked here, then by the server (D7, D9). */
  function take(raw: string) {
    const r = scanned(stateRef.current, raw);
    commit(r.state);
    if (!r.check) return;
    const sku = r.check;
    api.skiSwap.ticketCheck(orgId, swapId, sku)
      .then((res) => commit(checked(stateRef.current, sku, res)))
      .catch(() => commit(uncheckable(stateRef.current, sku)));
  }
  const takeRef = useRef(take);
  takeRef.current = take;

  const scanning = !!seller && saved === null && !saving;
  const { subscribe } = scanner;
  useEffect(() => {
    if (!scanning) return;
    return subscribe((scan) => takeRef.current(scan.payload));
  }, [scanning, subscribe]);

  // Unsaved tickets aren't lost to a stray close of the tab (D8).
  const unsaved = state.tickets.length > 0 && saved === null;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return sellers
      .filter((s) => !q
        || s.displayName.toLowerCase().includes(q)
        || (s.email ?? '').toLowerCase().includes(q)
        || (digits.length > 0 && (s.phone ?? '').includes(digits)))
      .slice(0, 12);
  }, [search, sellers]);

  function abort() {
    if (unsaved && !confirm(`Discard ${state.tickets.length} scanned ticket${state.tickets.length === 1 ? '' : 's'}?`)) return;
    onClose();
  }

  async function connect() {
    setConnectError(null);
    try {
      await scanner.connect();
    } catch (err: unknown) {
      setConnectError((err as { name?: string })?.name === 'NotFoundError'
        ? 'No scanner picked. If nothing was listed, it’s asleep, out of range, or held by a bridge. Press its trigger to wake it, and try again.'
        : (err as Error)?.message ?? 'Could not connect to the scanner.');
    }
  }

  async function save() {
    if (!seller) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.skiSwap.batchAddTickets(orgId, swapId, seller.id, toSave(stateRef.current), keyRef.current);
      setSaved(res.created);
      onSaved();
    } catch (err: unknown) {
      if (!(err instanceof ApiError)) {
        // No answer at all ("Failed to fetch"): the save may or may not have
        // landed. The key stays, so pressing Save again answers as the first
        // did if it landed, and adds them if it didn't. Never twice.
        setSaveError('The connection dropped before PatrolKit answered, so these may already be saved. Press Save again: if they were saved, nothing is added twice.');
        return;
      }
      const taken = err.code === 'TICKET_TAKEN'
        ? (err.details as { taken?: { sku: string; holder: string | null }[] } | undefined)?.taken
        : undefined;
      if (taken?.length) commit(markedTaken(stateRef.current, taken));
      // A refusal is the server's sentence; nothing was added, so a new key for the next try.
      keyRef.current = idempotencyKey();
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const count = state.tickets.length;
  const checking = state.tickets.some((t) => t.status === 'checking');
  const takenCount = state.tickets.filter((t) => t.status === 'taken').length;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center p-4 pt-[6vh] z-50">
      <div role="dialog" aria-modal="true" aria-label="Batch add to seller"
        className="bg-surface-50 border border-gray-700 rounded-lg w-full max-w-2xl p-5 space-y-4 max-h-[88vh] flex flex-col">
        <div className="flex items-start justify-between gap-4 shrink-0">
          <div>
            <h3 className="text-white font-medium">Batch Add to Seller</h3>
            <p className="text-gray-400 text-sm mt-0.5">
              {seller ? <>Adding legacy tickets to <span className="text-white">{seller.displayName}</span>.</> : 'Choose the seller whose tickets you’re scanning.'}
            </p>
          </div>
          {saved === null && (
            <button type="button" onClick={abort} className="shrink-0 bg-surface-100 hover:bg-surface-200 text-gray-200 px-3 py-1.5 rounded text-sm">
              Abort
            </button>
          )}
        </div>

        {!seller && (
          <div className="space-y-2 min-h-0 flex flex-col">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sellers by name, email or phone"
              aria-label="Search sellers"
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
            />
            <ul className="overflow-y-auto divide-y divide-gray-800 border border-gray-800 rounded">
              {matches.length === 0 && <li className="px-3 py-2 text-sm text-gray-500">No seller matches that.</li>}
              {matches.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setSeller(s)} className="w-full text-left px-3 py-2 hover:bg-surface-100">
                    <span className="text-sm text-white">{s.displayName}</span>
                    <span className="ml-2 text-xs text-gray-500">{[s.email, s.phone].filter(Boolean).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {seller && saved === null && (
          <>
            {/* The scanner, said so it can't be missed (D6). */}
            {!scanner.isSupported ? (
              <Banner tone="error" icon={faTriangleExclamationDuo} title="This browser can’t use a scanner"
                text="Scanning needs Chrome or Edge, which can use Bluetooth. You can still type ticket numbers below." />
            ) : scanner.scanners.length === 0 ? (
              <Banner tone="error" icon={faTriangleExclamationDuo} title="No scanner set up"
                text="Add one on the Hardware page. You can still type ticket numbers below." />
            ) : !scanner.connected ? (
              <Banner tone="error" icon={faTriangleExclamationDuo} title="Scanner not connected"
                text={connectError ?? 'Connect it to start scanning. Nothing scanned so far is lost.'}
                action={
                  <button type="button" onClick={() => void connect()} disabled={scanner.connecting}
                    className="bg-red-700 hover:bg-red-600 text-white px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
                    {scanner.connecting ? 'Connecting…' : 'Connect scanner'}
                  </button>
                } />
            ) : (
              <Banner tone="ready" icon={faScannerGunDuo}
                title={count === 0 ? 'Start scanning' : 'Keep scanning'}
                text={`Scan each ticket on ${seller.displayName}’s gear. Press Save when you’re done.`} />
            )}

            {state.rejection && (
              <Banner tone="error" icon={faCircleXmarkDuo} title={state.rejection.headline} text={state.rejection.advice} />
            )}

            <div className="grid grid-cols-2 gap-3 shrink-0">
              <div className="bg-surface-100 rounded-lg px-4 py-3">
                <p className="text-xs uppercase text-gray-500">Last ticket</p>
                <p className="text-3xl font-mono font-bold text-white mt-1" aria-live="polite">{state.last ?? '—'}</p>
              </div>
              <div className="bg-surface-100 rounded-lg px-4 py-3">
                <p className="text-xs uppercase text-gray-500">Tickets</p>
                <p className="text-3xl font-bold text-white mt-1">{count.toLocaleString('en-US')}</p>
              </div>
            </div>

            <form
              className="flex gap-2 shrink-0"
              onSubmit={(e) => { e.preventDefault(); take(typed); setTyped(''); }}
            >
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                inputMode="numeric"
                placeholder="Barcode won’t read? Type the ticket number"
                aria-label="Type a ticket number"
                className="flex-1 bg-surface-100 border border-gray-700 rounded px-3 py-1.5 text-sm text-white font-mono"
              />
              <button type="submit" disabled={!typed.trim()} className="bg-surface-100 hover:bg-surface-200 text-gray-200 px-3 py-1.5 rounded text-sm disabled:opacity-40">
                Add
              </button>
            </form>

            <ul className="flex-1 min-h-0 overflow-y-auto border border-gray-800 rounded divide-y divide-gray-800" aria-label="Scanned tickets">
              {count === 0 && <li className="px-3 py-3 text-sm text-gray-500">Scanned tickets appear here, newest first.</li>}
              {state.tickets.map((t) => (
                <li key={t.sku} className={`flex items-center justify-between px-3 py-1.5 text-sm ${t.status === 'taken' ? 'bg-red-900/20' : ''}`}>
                  <span className="font-mono text-gray-200">{t.sku}</span>
                  <span className="flex items-center gap-3">
                    {t.status === 'checking' && <span className="text-xs text-gray-500">Checking…</span>}
                    {t.status === 'taken' && <span className="text-xs text-red-400">Belongs to {t.holder ?? 'another item'}</span>}
                    <button type="button" onClick={() => commit(removed(stateRef.current, t.sku))}
                      aria-label={`Remove ${t.sku}`} className="text-gray-500 hover:text-red-400 text-base leading-none">×</button>
                  </span>
                </li>
              ))}
            </ul>

            {saveError && <p className="text-sm text-red-400 shrink-0">{saveError}</p>}
            <div className="flex items-center justify-between gap-3 shrink-0">
              <p className="text-xs text-gray-500">
                {takenCount > 0
                  ? `Remove the ${takenCount} marked red, then save.`
                  : 'Each becomes this seller’s item, on sale with no price. Price them later with Fast Edit Tickets.'}
              </p>
              <button
                type="button"
                onClick={() => void save()}
                disabled={count === 0 || checking || takenCount > 0 || saving}
                className="shrink-0 bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium disabled:opacity-40"
              >
                {saving ? 'Saving…' : `Save ${count.toLocaleString('en-US')} Ticket${count === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}

        {saved !== null && seller && (
          <Saved orgId={orgId} swapId={swapId} created={saved} sellerName={seller.displayName} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function Banner({ tone, icon, title, text, action }: {
  tone: 'error' | 'ready';
  icon: Parameters<typeof FontAwesomeIcon>[0]['icon'];
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  // Green, not the brand's red: "go" and "done" mustn't look like the errors.
  const look = tone === 'error'
    ? 'bg-red-950/60 border-red-800 text-red-200'
    : 'bg-green-950/40 border-green-800 text-white';
  return (
    <div className={`shrink-0 border rounded-lg px-4 py-3 flex items-center gap-4 ${look}`} role={tone === 'error' ? 'alert' : 'status'}>
      <FontAwesomeIcon icon={icon} className={`text-3xl shrink-0 ${tone === 'error' ? 'text-red-400' : 'text-green-400'}`} />
      <div className="flex-1 min-w-0">
        <p className="text-lg font-semibold">{title}</p>
        <p className="text-sm opacity-80">{text}</p>
      </div>
      {action}
    </div>
  );
}

/** After saving (D12): what was added, and Square catching up. */
function Saved({ orgId, swapId, created, sellerName, onClose }: {
  orgId: string; swapId: string; created: number; sellerName: string; onClose: () => void;
}) {
  const { data: push } = useTicketPushStatus(orgId, swapId, true);
  return (
    <div className="space-y-4">
      <Banner tone="ready" icon={faCircleCheckDuo}
        title={`Added ${created.toLocaleString('en-US')} ticket${created === 1 ? '' : 's'} to ${sellerName}`}
        text="Each is on sale with no price. Price them with Fast Edit Tickets." />
      <p className="text-sm text-gray-400">
        {!push ? 'Checking Square…'
          : !push.squareReady ? 'Square isn’t set up for this swap, so these aren’t on sale yet.'
            : push.pushing ? `Putting tickets in Square: ${push.notInSquare.toLocaleString('en-US')} to go…`
              : push.notInSquare > 0 ? `${push.notInSquare.toLocaleString('en-US')} aren’t in Square yet. Finish from the Items page’s Actions.`
                : 'All in Square.'}
      </p>
      <div className="flex justify-end">
        <button type="button" onClick={onClose} autoFocus className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">
          Done
        </button>
      </div>
    </div>
  );
}
