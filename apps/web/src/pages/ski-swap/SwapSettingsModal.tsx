import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { SwapResponse } from '../../lib/api.types';
import { SELLER_SITE_URL } from '../../lib/sellerSiteUrl';
import { deriveSwapSlug, SWAP_SLUG_PATTERN, swapStatusUrl } from '../../lib/swapSlug';
import {
  changes, formFor, receiptLinkOptions, receiptSettingsProblem, ticketSettingsProblem, type SwapForm,
} from './swapSettingsForm';

// The editor comes with the dialog, not with the rest of the app.
const FinePrintEditor = lazy(() => import('./FinePrintEditor'));

type Tab = 'general' | 'tickets' | 'status' | 'receipts';

/**
 * A swap's settings, in a dialog with four tabs (Plans 33 and 36): General,
 * Tickets (once the swap exists, as before), Status Page and Receipts. One
 * Save sends what changed.
 */
export default function SwapSettingsModal({
  orgId,
  orgSlug,
  swap,
  onClose,
  onSaved,
}: {
  orgId: string;
  orgSlug: string;
  /** Null to create one. */
  swap: SwapResponse | null;
  onClose: () => void;
  onSaved: (swap: SwapResponse) => void;
}) {
  const [tab, setTab] = useState<Tab>('general');
  const [form, setForm] = useState<SwapForm>(() => formFor(swap));
  // On create the slug follows the title until somebody types one.
  const [slugEdited, setSlugEdited] = useState(!!swap);
  const [error, setError] = useState<{ tab: Tab; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { data: locationsData, isLoading: locationsLoading, error: locationsError } = useQuery({
    queryKey: ['ski-swap/locations', orgId],
    queryFn: () => api.skiSwap.listLocations(orgId),
    staleTime: 60_000,
  });
  const locations = useMemo(() => locationsData?.locations ?? [], [locationsData]);
  // One location is the only choice there is, so it's chosen.
  useEffect(() => {
    if (locations.length === 1 && !form.locationId) setForm((f) => ({ ...f, locationId: locations[0].id }));
  }, [locations, form.locationId]);

  const slugValid = SWAP_SLUG_PATTERN.test(form.slug);
  const statusUrl = swapStatusUrl(SELLER_SITE_URL, orgSlug, form.slug || '…');

  const save = useMutation({
    mutationFn: () => {
      if (!swap) {
        const {
          title, locationId, slug, skuLookupEnabled, sellerLookupEnabled, sellerLoginEnabled,
          receiptMode, receiptShowSku, receiptShowName, receiptShowPrice, receiptLink,
          receiptPrintEnabled, receiptPaperSize, receiptFinePrintEnabled, receiptFinePrint,
        } = form;
        return api.skiSwap.createSwap(orgId, {
          title, locationId, slug, skuLookupEnabled, sellerLookupEnabled, sellerLoginEnabled,
          receiptMode, receiptShowSku, receiptShowName, receiptShowPrice, receiptLink,
          receiptPrintEnabled, receiptPaperSize, receiptFinePrintEnabled, receiptFinePrint,
        });
      }
      return api.skiSwap.patchSwap(orgId, swap.id, changes(form, swap));
    },
    onSuccess: onSaved,
    onError: (err: Error) => {
      const message = err instanceof ApiError ? err.message : 'Could not save the swap';
      // A slug clash belongs on the tab with the slug.
      const onSlug = /slug/i.test(message);
      if (onSlug) setTab('general');
      setError({ tab: onSlug ? 'general' : tab, message });
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Nothing changed is nothing to save. The server refuses an empty update,
    // so saving one just closes the dialog.
    if (swap && Object.keys(changes(form, swap)).length === 0) {
      onClose();
      return;
    }
    if (!slugValid) {
      setTab('general');
      setError({ tab: 'general', message: 'A slug is up to 40 lowercase letters, digits and hyphens.' });
      return;
    }
    if (swap && form.slug !== swap.slug && !confirm(
      `Change the slug from "${swap.slug}" to "${form.slug}"?\n\n` +
      'The status page’s address changes, and the old one stops working.',
    )) return;
    save.mutate();
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'general', label: 'General' },
    // Once the swap exists, as before: a new swap starts on printed tags.
    ...(swap ? [{ key: 'tickets' as const, label: 'Tickets' }] : []),
    { key: 'status', label: 'Status Page' },
    { key: 'receipts', label: 'Receipts' },
  ];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={swap ? `Edit ${swap.title}` : 'New swap'}
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="bg-surface-50 border border-gray-700 rounded-lg w-full max-w-xl flex flex-col max-h-[calc(100vh-2rem)]"
      >
        <div className="px-5 pt-5 space-y-3 shrink-0">
          <h3 className="text-white font-medium">{swap ? `Edit ${swap.title}` : 'New Swap'}</h3>
          <div className="flex gap-1 border-b border-gray-700 pb-2" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 rounded text-sm ${tab === t.key ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-gray-200'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {tab === 'general' && (
            <>
              <label className="block">
                <span className="text-gray-400 text-xs uppercase">Title</span>
                <input
                  required
                  value={form.title}
                  onChange={(e) => setForm({
                    ...form,
                    title: e.target.value,
                    ...(slugEdited ? {} : { slug: deriveSwapSlug(e.target.value) }),
                  })}
                  placeholder='e.g. "Ski Swap 2026"'
                  className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                />
              </label>

              {/* These come from Square, not from PatrolKit: the list is
                  whatever the connected Square account has. */}
              <label className="block">
                <span className="text-gray-400 text-xs uppercase">Square Location</span>
                {locationsLoading ? (
                  <p className="mt-1 text-gray-500 text-sm">Loading locations from Square…</p>
                ) : locationsError ? (
                  <p className="mt-1 text-red-400 text-sm">
                    {locationsError instanceof ApiError ? locationsError.message : 'Could not load locations from Square'}
                  </p>
                ) : locations.length === 0 ? (
                  <p className="mt-1 text-red-400 text-sm">
                    No active locations found in Square. Check your Square credentials under Administration.
                  </p>
                ) : (
                  <>
                    <select
                      required
                      value={form.locationId}
                      onChange={(e) => setForm({ ...form, locationId: e.target.value })}
                      className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                    >
                      {locations.length > 1 && <option value="">Select a Square location…</option>}
                      {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                    <p className="mt-1 text-gray-500 text-xs">
                      {locations.length === 1 ? 'One Square location found, selected automatically. ' : ''}
                      Items in this swap are listed and their inventory tracked against this location in
                      your Square account. It is not the venue address.
                    </p>
                  </>
                )}
              </label>

              <label className="block">
                <span className="text-gray-400 text-xs uppercase">Slug</span>
                <input
                  required
                  value={form.slug}
                  onChange={(e) => {
                    setSlugEdited(true);
                    setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') });
                  }}
                  maxLength={40}
                  placeholder="e.g. ss26"
                  className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono"
                />
                <span className="mt-1 block text-gray-500 text-xs break-all">
                  The swap’s public address: {statusUrl}
                </span>
              </label>
            </>
          )}

          {tab === 'tickets' && swap && <TicketSettings form={form} setForm={setForm} />}

          {tab === 'status' && (
            <>
              <Toggle
                checked={form.skuLookupEnabled}
                onChange={(on) => setForm({ ...form, skuLookupEnabled: on })}
                title="Unauthenticated SKU Lookup"
                description="Anyone can enter a SKU and see whether that item has sold. Nothing else about it or its seller is shown."
              >
                {form.skuLookupEnabled && (
                  <span className="mt-2 flex items-center gap-2">
                    <a href={statusUrl} target="_blank" rel="noreferrer" className="text-xs text-brand-500 hover:underline break-all">
                      {statusUrl}
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(statusUrl).then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        });
                      }}
                      className="shrink-0 text-xs bg-surface-100 hover:bg-surface-200 text-gray-300 px-2 py-1 rounded"
                    >
                      {copied ? 'Copied' : 'Copy link'}
                    </button>
                  </span>
                )}
                {form.skuLookupEnabled && swap && form.slug !== swap.slug && (
                  <span className="mt-1 block text-xs text-amber-400">This link works once you save.</span>
                )}
              </Toggle>
              <Toggle
                checked={form.sellerLookupEnabled}
                onChange={(on) => setForm({ ...form, sellerLookupEnabled: on })}
                title="Unauthenticated Seller Status"
                description="Sellers can find their items by email and the last 4 digits of their phone, and see everything they’re selling here."
              />
              <Toggle
                checked={form.sellerLoginEnabled}
                onChange={(on) => setForm({ ...form, sellerLoginEnabled: on })}
                title="Authenticated Seller Status"
                description="Sellers can sign in to PatrolKit and see their items. Off, only patrollers, members and shops can sign in."
              />
            </>
          )}

          {tab === 'receipts' && <ReceiptSettings form={form} setForm={setForm} />}

          {error && error.tab === tab && <p className="text-sm text-red-400">{error.message}</p>}
        </div>

        <div className="flex gap-2 px-5 py-4 shrink-0 border-t border-gray-700">
          <button
            type="submit"
            disabled={save.isPending || !form.locationId || !form.title.trim() || !form.slug || !!ticketSettingsProblem(form) || !!receiptSettingsProblem(form)}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm font-medium"
          >
            {save.isPending ? 'Saving…' : swap ? 'Save' : 'Create'}
          </button>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white text-sm px-3 py-2">
            Cancel
          </button>
          {error && error.tab !== tab && <p className="self-center text-sm text-red-400">{error.message}</p>}
        </div>
      </form>
    </div>
  );
}

function Toggle({ checked, onChange, title, description, children, indent = 0 }: {
  checked: boolean;
  onChange: (on: boolean) => void;
  title: string;
  description: string;
  children?: ReactNode;
  /** Nesting under a heading: 0, 1 or 2 steps in. */
  indent?: 0 | 1 | 2;
}) {
  return (
    <label className={`flex items-start gap-3 ${['', 'pl-7', 'pl-14'][indent]}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-sm text-white">{title}</span>
        <span className="block text-gray-500 text-xs mt-0.5">{description}</span>
        {children}
      </span>
    </label>
  );
}

/**
 * How items come in, said positively, per place (Plan 34). The two "Allow"
 * lines are headings; the toggles under them are the settings. Each place must
 * keep at least one way in, which `ticketSettingsProblem` says before saving.
 */
function TicketSettings({ form, setForm }: { form: SwapForm; setForm: (f: SwapForm) => void }) {
  const problem = ticketSettingsProblem(form);
  return (
    <>
      <div className="space-y-3">
        <div>
          <span className="block text-sm text-white">Allow Legacy Tickets</span>
          <span className="block text-gray-500 text-xs mt-0.5">
            Gear that arrives already carrying a numbered ticket from the old stockpile. Ticket blocks can be
            issued to business sellers when either place takes them.
          </span>
        </div>
        <Toggle
          indent={1}
          checked={form.allowLegacyCheckin}
          onChange={(on) => setForm({
            ...form,
            allowLegacyCheckin: on,
            // Helper labels go with legacy tickets at check-in, and go with them.
            printLegacyHelperLabels: on ? form.printLegacyHelperLabels : false,
          })}
          title="Staff Check-In"
          description="The staff iPad can scan a legacy ticket in at the counter."
        />
        {form.allowLegacyCheckin && (
          <Toggle
            indent={2}
            checked={form.printLegacyHelperLabels}
            onChange={(on) => setForm({ ...form, printLegacyHelperLabels: on })}
            title="Print Helper Labels"
            description="The staff iPad prints a helper label to go with each legacy ticket."
          />
        )}
        <Toggle
          indent={1}
          checked={form.allowLegacyWeb}
          onChange={(on) => setForm({ ...form, allowLegacyWeb: on })}
          title="Web UI"
          description="A shop can enter its tickets, or upload them, on the web, and staff can upload them for one."
        />
      </div>

      <div className="space-y-3">
        <div>
          <span className="block text-sm text-white">Allow Print Tickets</span>
          <span className="block text-gray-500 text-xs mt-0.5">
            A tag printed here, with a SKU PatrolKit makes.
          </span>
        </div>
        <Toggle
          indent={1}
          checked={form.allowPrintCheckin}
          onChange={(on) => setForm({ ...form, allowPrintCheckin: on })}
          title="Staff Check-In"
          description="Items checked in at the counter can get a printed tag."
        />
        <Toggle
          indent={1}
          checked={form.allowPrintWeb}
          onChange={(on) => setForm({ ...form, allowPrintWeb: on })}
          title="Web UI"
          description="Items entered or uploaded on the web can get a printed tag."
        />
      </div>

      {problem && <p className="text-sm text-amber-400">{problem}</p>}

      <div className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-sm text-white">Labels per item</span>
          <span className="block text-gray-500 text-xs mt-0.5">
            Price tags printed each time an item’s tag is printed, for this swap.
          </span>
        </span>
        <span className="flex items-center gap-2" role="group" aria-label="Labels per item">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={form.labelsPerItem === n}
              onClick={() => setForm({ ...form, labelsPerItem: n })}
              className={`w-9 h-9 rounded text-sm font-medium transition ${form.labelsPerItem === n ? 'bg-brand-600 text-white' : 'bg-surface-100 text-gray-300 hover:bg-surface-200'}`}
            >
              {n}
            </button>
          ))}
        </span>
      </div>
    </>
  );
}

const RECEIPT_LINK_NONE_LABEL = 'No link';

/**
 * What a seller's receipt is (Plan 36): itemized, a status page only, or none;
 * whether it prints, and on what; and its fine print. The link follows the
 * Status Page tab's toggles as they stand in this dialog.
 */
function ReceiptSettings({ form, setForm }: { form: SwapForm; setForm: (f: SwapForm) => void }) {
  const problem = receiptSettingsProblem(form);
  const options = receiptLinkOptions(form);
  const noPages = options.length === 0;
  const giving = form.receiptMode !== 'NONE';

  const linkPicker = (
    <label className="block pl-7">
      <span className="block text-sm text-white">Link to status page</span>
      <select
        value={form.receiptLink}
        disabled={noPages}
        onChange={(e) => setForm({ ...form, receiptLink: e.target.value as SwapForm['receiptLink'] })}
        className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        {form.receiptMode !== 'STATUS_ONLY' && <option value="NONE">{RECEIPT_LINK_NONE_LABEL}</option>}
        {/* A stored choice whose page is now off stays chosen, and says so. */}
        {form.receiptLink !== 'NONE' && !options.some((o) => o.value === form.receiptLink) && (
          <option value={form.receiptLink}>{LINK_NAMES[form.receiptLink]} (off)</option>
        )}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {noPages ? (
        <span className="mt-1 block text-gray-500 text-xs">Turn on a status page to link to it.</span>
      ) : form.receiptLink !== 'NONE' && !options.some((o) => o.value === form.receiptLink) ? (
        <span className="mt-1 block text-amber-400 text-xs">That page is off, so receipts show no link.</span>
      ) : null}
    </label>
  );

  function setMode(receiptMode: SwapForm['receiptMode']) {
    // Status page only needs a page: pick the first one on if none is chosen.
    const receiptLink = receiptMode === 'STATUS_ONLY' && form.receiptLink === 'NONE' && options.length
      ? options[0].value
      : form.receiptLink;
    setForm({ ...form, receiptMode, receiptLink });
  }

  return (
    <>
      <div className="space-y-3" role="radiogroup" aria-label="Receipt">
        <Radio
          checked={form.receiptMode === 'ITEMIZED'}
          onChange={() => setMode('ITEMIZED')}
          title="Itemized"
          description="A line for each item checked in."
        />
        {form.receiptMode === 'ITEMIZED' && (
          <>
            <Toggle
              indent={1}
              checked={form.receiptShowSku}
              onChange={(on) => setForm({ ...form, receiptShowSku: on })}
              title="SKU"
              description="Each item’s SKU."
            />
            <Toggle
              indent={1}
              checked={form.receiptShowName}
              onChange={(on) => setForm({ ...form, receiptShowName: on })}
              title="Description"
              description="Each item’s name, as on its tag."
            />
            <Toggle
              indent={1}
              checked={form.receiptShowPrice}
              onChange={(on) => setForm({ ...form, receiptShowPrice: on })}
              title="Price"
              description="Each item’s price, and the total."
            />
            {linkPicker}
          </>
        )}

        <Radio
          checked={form.receiptMode === 'STATUS_ONLY'}
          onChange={() => setMode('STATUS_ONLY')}
          disabled={noPages && form.receiptMode !== 'STATUS_ONLY'}
          title="Status page only"
          description={noPages
            ? 'No items, just a link to a status page. Turn on a status page to choose this.'
            : 'No items, just a link to a status page.'}
        />
        {form.receiptMode === 'STATUS_ONLY' && linkPicker}

        <Radio
          checked={form.receiptMode === 'NONE'}
          onChange={() => setMode('NONE')}
          title="None"
          description="Sellers get no receipt: none is emailed, texted or printed."
        />
      </div>

      {giving && (
        <>
          <Toggle
            checked={form.receiptPrintEnabled}
            onChange={(on) => setForm({ ...form, receiptPrintEnabled: on })}
            title="Allow printing"
            description="Receipts can be printed at check-in and from a seller’s page. Off, they’re emailed and texted only."
          >
            {form.receiptPrintEnabled && (
              <select
                aria-label="Paper size"
                value={form.receiptPaperSize}
                onChange={(e) => setForm({ ...form, receiptPaperSize: e.target.value as SwapForm['receiptPaperSize'] })}
                className="mt-2 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
              >
                <option value="62x100">62 × 100 mm (tall)</option>
                <option value="50x30">50 × 30 mm (compact)</option>
              </select>
            )}
            {form.receiptPrintEnabled && (
              <span className="mt-1 block text-gray-500 text-xs">
                A printer loaded with other paper won’t print receipts for this swap.
              </span>
            )}
          </Toggle>

          <div>
            <Toggle
              checked={form.receiptFinePrintEnabled}
              onChange={(on) => setForm({ ...form, receiptFinePrintEnabled: on })}
              title="Fine print"
              description="A short note at the foot of the emailed receipt and the receipt page. It isn’t printed."
            />
            {form.receiptFinePrintEnabled && (
              <div className="pl-7">
                <Suspense fallback={<p className="mt-2 text-xs text-gray-500">Loading the editor…</p>}>
                  <FinePrintEditor
                    value={form.receiptFinePrint}
                    onChange={(receiptFinePrint) => setForm({ ...form, receiptFinePrint })}
                  />
                </Suspense>
              </div>
            )}
          </div>
        </>
      )}

      {problem && <p className="text-sm text-amber-400">{problem}</p>}
    </>
  );
}

const LINK_NAMES: Record<SwapForm['receiptLink'], string> = {
  NONE: RECEIPT_LINK_NONE_LABEL,
  SKU_LOOKUP: 'Unauthenticated SKU Lookup',
  SELLER_STATUS: 'Unauthenticated Seller Status',
  SELLER_LOGIN: 'Authenticated Seller Status',
};

function Radio({ checked, onChange, title, description, disabled = false }: {
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-50' : ''}`}>
      <input type="radio" name="receiptMode" checked={checked} disabled={disabled} onChange={onChange} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-sm text-white">{title}</span>
        <span className="block text-gray-500 text-xs mt-0.5">{description}</span>
      </span>
    </label>
  );
}
