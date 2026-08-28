import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCamera as faCameraDuo,
  faCheck as faCheckDuo,
  faRotateRight as faRotateRightDuo,
  faSpinner as faSpinnerDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import { downscaleImage } from '../../lib/downscaleImage';
import {
  CheckinShell, contextLine, ErrorNote, formatCents, inputClass,
  parsePriceCents, primaryButtonClass, secondaryButtonClass,
} from './shared';
import type { CheckinContext, CheckinSummary } from '../../lib/api.types';

/**
 * A key unique to one save attempt.
 *
 * `crypto.randomUUID` needs iOS 15.4, and this is the one screen guaranteed to
 * meet older phones — a seller's handset is whatever they own. The fallback only
 * has to be unique among one person's saves, not globally.
 */
function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Survives a reload, a backgrounded tab, and Safari discarding the page. */
function draftKey(swapId: string) {
  return `patrolkit:checkin:draft:${swapId}`;
}

interface Draft {
  name: string;
  price: string;
}

/**
 * Entering items, one at a time.
 *
 * The screen the whole flow exists for. One column, the primary action within
 * thumb reach, and the form stays short enough to use in the ~300px the iOS
 * keyboard leaves behind. Printing is visible: every item shows whether its tag
 * has come out, and offers a reprint when it has not.
 */
export default function ItemsStep({
  context,
  onFinished,
}: {
  context: CheckinContext;
  onFinished: () => void;
}) {
  const qc = useQueryClient();
  const summaryKey = ['checkin/summary', context.orgId, context.swapId];

  const { data: summary } = useQuery<CheckinSummary>({
    queryKey: summaryKey,
    queryFn: () => api.checkin.summary(context.orgId, context.swapId),
    // Tags are printed by hardware across the room; polling is how the screen
    // learns one came out. Cheap, and only while this screen is open.
    refetchInterval: 3000,
  });

  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const raw = localStorage.getItem(draftKey(context.swapId));
      return raw ? (JSON.parse(raw) as Draft) : { name: '', price: '' };
    } catch {
      return { name: '', price: '' };
    }
  });
  const [photo, setPhoto] = useState<{ file: File; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [reprinting, setReprinting] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // A half-typed item survives a reload. Sellers put phones down mid-check-in,
  // and Safari discards backgrounded tabs without asking.
  useEffect(() => {
    localStorage.setItem(draftKey(context.swapId), JSON.stringify(draft));
  }, [draft, context.swapId]);

  const priceCents = parsePriceCents(draft.price);
  const canAdd = draft.name.trim().length > 0 && priceCents !== null;

  async function addItem() {
    if (!canAdd) return;
    setBusy(true);
    setError('');
    // Generated per attempt, kept across retries of that attempt: the point is
    // that a dropped response does not mint a second SKU and print a second tag.
    const key = idempotencyKey();
    try {
      const item = await api.skiSwap.sellerCreateItem(
        context.orgId,
        {
          swapId: context.swapId,
          name: draft.name.trim(),
          priceCents: priceCents!,
          quantity: 1,
          stationId: context.stationId,
        },
        key,
      );

      if (photo) {
        // Best-effort: the item and its tag are the deliverable, and a failed
        // photo upload must not cost the seller the entry they just typed.
        await api.skiSwap
          .sellerUploadPhoto(context.orgId, item.id, await downscaleImage(photo.file))
          .catch(() => {});
        URL.revokeObjectURL(photo.preview);
        setPhoto(null);
      }

      setDraft({ name: '', price: '' });
      await qc.invalidateQueries({ queryKey: summaryKey });
      nameRef.current?.focus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that item');
    } finally {
      setBusy(false);
    }
  }

  async function reprint(itemId: string) {
    setReprinting(itemId);
    setError('');
    try {
      await api.skiSwap.sellerReprintItem(context.orgId, itemId, context.stationId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reprint that tag');
    } finally {
      setReprinting(null);
    }
  }

  async function finish() {
    setFinishing(true);
    setError('');
    try {
      await api.checkin.finish(context.orgId, context.swapId, context.stationId);
      localStorage.removeItem(draftKey(context.swapId));
      onFinished();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not finish check-in');
      setFinishing(false);
    }
  }

  const items = summary?.items ?? [];

  return (
    <CheckinShell
      title="Add your items"
      subtitle={contextLine(context)}
      logoUrl={context.orgLogoUrl}
    >
      <div className="space-y-3 bg-surface-50 border border-gray-800 rounded-xl p-4">
        <input
          ref={nameRef}
          className={inputClass}
          placeholder="What is it? e.g. Volkl Kendo skis, 177cm"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          autoFocus
        />
        <input
          className={inputClass}
          // Decimal, not numeric: the price has a decimal point in it, and the
          // numeric keypad on iOS does not offer one.
          inputMode="decimal"
          placeholder="Price, e.g. 45.00"
          value={draft.price}
          onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))}
        />

        {photo ? (
          <div className="flex items-center gap-3">
            <img src={photo.preview} alt="" className="h-16 w-16 rounded-lg object-cover" />
            <button
              className="text-sm text-gray-400 hover:text-gray-200"
              onClick={() => { URL.revokeObjectURL(photo.preview); setPhoto(null); }}
            >
              Remove photo
            </button>
          </div>
        ) : (
          <label className={`${secondaryButtonClass} flex items-center justify-center gap-2 cursor-pointer`}>
            <FontAwesomeIcon icon={faCameraDuo} />
            Add a photo (optional)
            <input
              type="file"
              accept="image/*"
              // Opens the camera directly rather than the photo library, which
              // is what someone standing over the item actually wants.
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) setPhoto({ file, preview: URL.createObjectURL(file) });
                e.target.value = '';
              }}
            />
          </label>
        )}

        <ErrorNote>{error}</ErrorNote>

        <button className={primaryButtonClass} disabled={!canAdd || busy} onClick={addItem}>
          {busy ? 'Saving…' : 'Add item and print tag'}
        </button>
      </div>

      {items.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between px-1">
            <h2 className="text-sm font-medium text-gray-300">
              {items.length} item{items.length === 1 ? '' : 's'}
            </h2>
            <span className="text-sm text-gray-400">{formatCents(summary!.totalCents)}</span>
          </div>

          <ul className="space-y-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="bg-surface-50 border border-gray-800 rounded-lg px-3 py-2.5 flex items-start gap-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white truncate">{item.name}</p>
                  <p className="text-xs text-gray-500">
                    {item.sku} · {formatCents(item.priceCents)}
                  </p>
                </div>
                {item.hasPrintedTag ? (
                  <span className="text-xs text-green-400 whitespace-nowrap pt-0.5">
                    <FontAwesomeIcon icon={faCheckDuo} /> Tag printed
                  </span>
                ) : (
                  <span className="text-xs text-amber-400 whitespace-nowrap pt-0.5">
                    <FontAwesomeIcon icon={faSpinnerDuo} spin /> Printing…
                  </span>
                )}
              </li>
            ))}
          </ul>

          {/* Reprint lives under the list rather than on every row: it is the
              rare action, and a tap target next to each item invites misfires. */}
          {items.some((i) => i.hasPrintedTag) && (
            <details className="px-1">
              <summary className="text-xs text-gray-500 cursor-pointer py-2">
                A tag did not come out properly?
              </summary>
              <ul className="space-y-1 pt-1">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      className="w-full text-left text-xs text-gray-400 hover:text-gray-200 py-2 px-2 rounded hover:bg-surface-100 disabled:opacity-40"
                      disabled={reprinting === item.id}
                      onClick={() => reprint(item.id)}
                    >
                      <FontAwesomeIcon icon={faRotateRightDuo} />{' '}
                      {reprinting === item.id ? 'Queued…' : `Reprint ${item.sku}`}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <button className={secondaryButtonClass} disabled={finishing} onClick={finish}>
            {finishing ? 'Printing your receipt…' : "I'm done — print my receipt"}
          </button>
        </div>
      )}
    </CheckinShell>
  );
}
