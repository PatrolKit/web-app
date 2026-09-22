import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCamera as faCameraDuo,
  faCheck as faCheckDuo,
  faCircleCheck as faCircleCheckDuo,
  faRotateRight as faRotateRightDuo,
  faSpinner as faSpinnerDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import ItemDescriber, {
  emptyDescriber, toAttributeInputs, NamePreview, type DescriberState,
} from '../../components/ItemDescriber';
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

/**
 * Survives a reload, a backgrounded tab, and Safari discarding the page.
 *
 * `v2` because the shape changed when the typed name became a described one
 * (Plan 19): a v1 draft parsed as v2 would restore a name field that no longer
 * exists and no category, which reads as a half-filled form nobody can finish.
 * A bumped key discards it instead.
 */
function draftKey(swapId: string) {
  return `patrolkit:checkin:draft:v2:${swapId}`;
}

interface Draft {
  describer: DescriberState;
  price: string;
  notes: string;
}

const emptyDraft: Draft = { describer: emptyDescriber, price: '', notes: '' };

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
  onFinished: (result: { awaitingConsignment: number; emailedTo: string | null }) => void;
}) {
  const qc = useQueryClient();
  const summaryKey = ['checkin/summary', context.orgId, context.swapId];

  const { data: summary } = useQuery<CheckinSummary>({
    queryKey: summaryKey,
    queryFn: () => api.checkin.summary(context.orgId, context.swapId),
    // Tags are printed by hardware across the room; polling is how the screen
    // learns one came out. Cheap, and only while this screen is open.
    //
    // Faster while a spinner is on screen, because that is the only time the
    // answer is being waited for: a seller watching "Printing…" notices three
    // seconds of it long after the tag is in their hand. Once everything has
    // printed there is nothing to catch up on, so it backs off.
    refetchInterval: (query) =>
      query.state.data?.items.some((i) => !i.hasPrintedTag) ? 1000 : 5000,
  });

  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const raw = localStorage.getItem(draftKey(context.swapId));
      if (!raw) return emptyDraft;
      const parsed = JSON.parse(raw) as Partial<Draft>;
      // Defended field by field: a draft written by an older build, or one a
      // browser truncated, must not leave the form in a state with no category.
      return {
        describer: parsed.describer?.answers ? parsed.describer : emptyDescriber,
        price: parsed.price ?? '',
        notes: parsed.notes ?? '',
      };
    } catch {
      return emptyDraft;
    }
  });
  const [photo, setPhoto] = useState<{ file: File; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [reprinting, setReprinting] = useState<string | null>(null);
  /**
   * The item just saved, if the seller has not moved on from it.
   *
   * Saving used to empty the form and leave the seller looking at it, which
   * says nothing about what happened — the item they entered was now a row in
   * a list below the fold, and so was the button that ends check-in. So the
   * screen answered "I added an item" with a blank form, and the only visible
   * next step was to fill it in again.
   *
   * Held as a snapshot rather than an id alone so the panel can name the item
   * in the same tick it saved, before the summary has refetched. The tag's
   * print state is still read live from the summary below.
   */
  const [added, setAdded] = useState<
    { id: string; name: string; sku: string; priceCents: number } | null
  >(null);
  const priceRef = useRef<HTMLInputElement>(null);

  // A half-typed item survives a reload. Sellers put phones down mid-check-in,
  // and Safari discards backgrounded tabs without asking.
  useEffect(() => {
    localStorage.setItem(draftKey(context.swapId), JSON.stringify(draft));
  }, [draft, context.swapId]);

  const priceCents = parsePriceCents(draft.price);
  // A category and a price, and nothing else (Plan 19 D6). "Skis — $45" is a
  // valid item, and it is less typing than the old free-text field was.
  const canAdd = draft.describer.categoryId !== null && priceCents !== null;

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
          categoryId: draft.describer.categoryId!,
          attributes: toAttributeInputs(draft.describer),
          ...(draft.notes.trim() ? { description: draft.notes.trim() } : {}),
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

      setDraft(emptyDraft);
      setAdded({ id: item.id, name: item.name, sku: item.sku, priceCents: item.priceCents });
      // The panel replaces a form the seller may have scrolled down inside.
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await qc.invalidateQueries({ queryKey: summaryKey });
      // A value the seller just typed is now a pending node the tree does not
      // offer, so the next item's picker has to refetch rather than show a list
      // that is one value out of date.
      await qc.invalidateQueries({ queryKey: ['taxonomy', context.orgId] });
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
      const result = await api.checkin.finish(context.orgId, context.swapId, context.stationId);
      localStorage.removeItem(draftKey(context.swapId));
      onFinished({
        awaitingConsignment: result.awaitingConsignment,
        emailedTo: result.emailedTo,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not finish check-in');
      setFinishing(false);
    }
  }

  const items = summary?.items ?? [];
  // The snapshot names it; the summary says whether its tag has come out yet.
  const addedLive = added ? items.find((i) => i.id === added.id) : undefined;

  /**
   * The way out of check-in, when it is one of two choices rather than the only
   * one on screen.
   *
   * Not `secondaryButtonClass`: grey on this flow is the retreat colour — "Fix
   * it", "use a different email" — and the button that ends check-in has already
   * been mistaken for a disabled one once. Outlined and white keeps it plainly
   * pressable while leaving the red for carrying on.
   */
  const finishButtonClass =
    'w-full py-3.5 rounded-lg bg-surface-100 hover:bg-surface-200 border border-gray-600 ' +
    'disabled:opacity-40 text-white text-base font-medium';

  return (
    <CheckinShell
      title="Add your items"
      subtitle={contextLine(context)}
      logoUrl={context.orgLogoUrl}
    >
      {added ? (
        <div className="space-y-3 bg-surface-50 border border-gray-800 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <FontAwesomeIcon icon={faCircleCheckDuo} className="h-5 w-5 text-green-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-white">{added.name}</p>
              <p className="text-xs text-gray-500">
                {added.sku} · {formatCents(added.priceCents)}
              </p>
            </div>
          </div>

          {/* The tag comes out of a printer across the room, so whether it has
              is the one thing a seller cannot see for themselves. */}
          {addedLive?.hasPrintedTag ? (
            <p className="text-xs text-green-400">
              <FontAwesomeIcon icon={faCheckDuo} /> Tag printed
            </p>
          ) : (
            <p className="text-xs text-amber-400">
              <FontAwesomeIcon icon={faSpinnerDuo} spin /> Printing its tag…
            </p>
          )}

          <ErrorNote>{error}</ErrorNote>

          {/* Red for carrying on, because most sellers arrive with more than one
              thing, and finishing early is the more expensive mistake — it
              prints a receipt and closes check-in. */}
          <button className={primaryButtonClass} onClick={() => setAdded(null)}>
            Add another item
          </button>
          <button className={finishButtonClass} disabled={finishing} onClick={finish}>
            {finishing ? 'Printing your receipt…' : "I'm done — print my receipt"}
          </button>
        </div>
      ) : (
      <div className="space-y-3 bg-surface-50 border border-gray-800 rounded-xl p-4">
        <ItemDescriber
          orgId={context.orgId}
          value={draft.describer}
          onChange={(describer) => setDraft((d) => ({ ...d, describer }))}
          layout="stacked"
          /**
           * The feedback loop that makes the form make sense: it is what shows a
           * seller that answering one more question improves their listing.
           * Rendered here rather than inside the describer so it sits directly
           * above the price, where the eye already is.
           */
          renderPreview={(name, { parts }) =>
            name ? <NamePreview name={name} parts={parts} /> : null
          }
        />

        <input
          ref={priceRef}
          className={inputClass}
          // Decimal, not numeric: the price has a decimal point in it, and the
          // numeric keypad on iOS does not offer one.
          inputMode="decimal"
          placeholder="Price, e.g. 45.00"
          value={draft.price}
          onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))}
        />

        {/* Free text did not disappear; it moved here, where it belongs. Never
            part of the name, and shown on the seller's own listing. */}
        <input
          className={inputClass}
          placeholder="Notes (optional) — a scratch, a missing strap"
          value={draft.notes}
          onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
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
      )}

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

          {/* Primary, like every other forward step in this flow. Grey is the
              retreat colour here — "Fix it", "use a different email" — so the
              one button that ends check-in was reading as disabled, next to a
              genuinely disabled Add button that looked more pressable than it.

              Hidden while the just-added panel is up, because that panel offers
              the same choice and two of this button on one screen is a
              question asked twice. */}
          {!added && (
            <button className={primaryButtonClass} disabled={finishing} onClick={finish}>
              {finishing ? 'Printing your receipt…' : "I'm done — print my receipt"}
            </button>
          )}
        </div>
      )}
    </CheckinShell>
  );
}
