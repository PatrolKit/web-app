import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPrint as faPrintDuo, faRotateRight as faRotateRightDuo, faTag as faTagDuo, faTriangleExclamation as faTriangleExclamationDuo } from '@fortawesome/pro-duotone-svg-icons';
import type { ItemAttributeInput, ItemResponse, SellerResponse } from '../../lib/api.types';
import SearchableSelect from '../../components/SearchableSelect';
import ItemDescriber, {
  emptyDescriber, toAttributeInputs, NamePreview, type DescriberState,
} from '../../components/ItemDescriber';
import { usePrinter } from '../../contexts/PrinterContext';
import { isWebBluetoothSupported } from '../../lib/printing/PhomemoPrinterService';

// ─── API adapter interface ────────────────────────────────────────────────────

export interface SwapItemsPanelApi {
  /**
   * `sellerId` is applied by the server, not by filtering what came back.
   *
   * The list is a page of fifty. A seller scope that only hid rows already
   * fetched would disagree with "accept everything this seller is waiting on",
   * which acts on all of them — and the button would quietly do more than the
   * screen showed.
   */
  fetchItems: (swapId: string, opts?: { query?: string; sellerId?: string }) => Promise<{ items: ItemResponse[]; total: number }>;
  /** Accepts every item this seller is still waiting on. Staff pages only. */
  consignAllForSeller?: (swapId: string, sellerId: string) => Promise<{ consigned: number; pushing: number }>;
  createItem: (swapId: string, data: CreateItemInput) => Promise<ItemResponse>;
  patchItem: (itemId: string, data: PatchItemInput) => Promise<ItemResponse>;
  deleteItem: (itemId: string) => Promise<void>;
  uploadPhoto?: (itemId: string, file: File) => Promise<{ id: string; url: string }>;
  deletePhoto?: (itemId: string, photoId: string) => Promise<void>;
}

export interface CreateItemInput {
  /** A ticket number, for a seller on issued tickets. Absent otherwise. */
  sku?: string;
  /** What the item is. The name is derived from this and the answers (Plan 19). */
  categoryId: string;
  attributes?: ItemAttributeInput[];
  description?: string;
  priceCents: number;
  quantity: number;
  sellerId?: string;
  donateProceeds?: boolean;
}

export interface PatchItemInput {
  categoryId?: string;
  attributes?: ItemAttributeInput[];
  description?: string | null;
  priceCents?: number;
  quantity?: number;
  sellerId?: string | null;
  donateProceeds?: boolean;
  hasPrintedTag?: boolean;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SwapItemsPanelProps {
  orgId: string;
  swapId: string | null;
  canManage: boolean;
  queryKeyPrefix: string;
  panelApi: SwapItemsPanelApi;
  /**
   * Present when the seller is on issued tickets rather than a printer. The
   * number replaces the minted SKU, the name stops being required, and there is
   * nothing to print — the tag is already on the goods.
   */
  tickets?: {
    ranges: { startNumber: number; endNumber: number }[];
    /** The number to offer. Null past the top of the ranges, which is not an error. */
    suggested: number | null;
    /** True only when nothing at all is unused — the one state that refuses. */
    exhausted: boolean;
    onUsed: () => void;
  };
  /**
   * True on a seller's own "My Items" page, false on the staff Items page.
   *
   * A seller may withdraw their own item until it is consigned — the moment it
   * becomes sellable, and on every path the same moment it reaches Square.
   * After that it has to be done at the counter, where somebody can see both
   * the gear and the tag. The server refuses either way; this stops the screen
   * offering a button that would be.
   */
  selfService?: boolean;
  showSearch?: boolean;
  sellers?: SellerResponse[];
  emptyMessage?: string;
  labelsPerItem?: number;
  /** Rendered beside Add item. The staff page uses it for the seller import. */
  toolbarExtra?: ReactNode;
}

// ─── Form state ───────────────────────────────────────────────────────────────

interface ItemFormData {
  describer: DescriberState;
  description: string;
  priceDollars: string;
  quantity: string;
  sellerId: string;
  donateProceeds: boolean;
  /** The ticket on the item, for a seller on issued tickets. */
  sku: string;
}

const emptyForm: ItemFormData = { describer: emptyDescriber, description: '', priceDollars: '', quantity: '1', sellerId: '', donateProceeds: false, sku: '' };

/** "67000–67499", or "67000–67499, 68000–68499" for a shop with two pads. */
function describeRanges(ranges: { startNumber: number; endNumber: number }[]): string {
  return ranges.map((r) => `${r.startNumber}–${r.endNumber}`).join(', ');
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * What is true of an item right now, as one cell.
 *
 * This replaces an "In Stock" and a "Sold" column which between them told a
 * lie. `soldCount` is not recorded anywhere — it is `originalQuantity - inStock`
 * — and `inStock` is zero for anything Square has never heard of. So an item
 * waiting for a volunteer to scan it, which has never been pushed, read as
 * fully **sold**: the one state where nothing has happened looked like the one
 * where everything had.
 *
 * Ordered by what stops a sale first, because only the first answer matters: an
 * unscanned item is not also "not in Square" as far as anybody acting on this
 * screen is concerned, it is unscanned, and scanning it fixes both.
 */
export type ItemStateKey = 'not_received' | 'not_in_square' | 'for_sale' | 'sold';

export const ITEM_STATE_FILTERS: { value: ItemStateKey; label: string }[] = [
  { value: 'not_received', label: 'Not yet received' },
  { value: 'not_in_square', label: 'Not in Square' },
  { value: 'for_sale', label: 'For sale' },
  { value: 'sold', label: 'Sold' },
];

/**
 * Accepts everything one seller is still waiting on.
 *
 * Says the number before it does anything, and says it again afterwards. A
 * button labelled "Consign all" on a screen showing a page of fifty invites
 * exactly one question — all of what? — so the count comes from the server's
 * total for this seller rather than from the rows on screen.
 */
function ConsignAllButton({
  sellerName, waiting, total, pending, result, error, onConsign,
}: {
  sellerName: string;
  /** Waiting on this page. Only ever used to decide whether to offer at all. */
  waiting: number;
  total: number;
  pending: boolean;
  result?: { consigned: number; pushing: number };
  error: unknown;
  onConsign: () => void;
}) {
  if (result) {
    return (
      <span className="text-sm text-gray-400">
        {result.consigned === 0
          ? 'Nothing was waiting.'
          : `Accepted ${result.consigned} item${result.consigned === 1 ? '' : 's'} — they appear in Square shortly.`}
      </span>
    );
  }
  if (!waiting) return null;

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => {
          if (confirm(
            `Accept everything ${sellerName} is still waiting on?\n\n` +
            'This puts their items in Square and they go on sale. It applies to ' +
            'all of their waiting items, not just the ones on this page.',
          )) onConsign();
        }}
        disabled={pending}
        className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded"
      >
        {pending ? 'Accepting…' : `Accept ${sellerName}'s items`}
      </button>
      {total > 0 && <span className="text-xs text-gray-500">{total} in this swap</span>}
      {!!error && (
        <span className="text-xs text-red-400">
          {/* `Error`, not `ApiError`: this panel takes its calls as a prop and
              has no business knowing which client made them. ApiError extends
              Error, so the server's sentence still comes through. */}
          {error instanceof Error ? error.message : 'Could not accept them'}
        </span>
      )}
    </div>
  );
}

export function itemState(item: ItemResponse): {
  key: ItemStateKey;
  label: string;
  tone: string;
  title: string;
} {
  const qty = item.originalQuantity;
  // Only where there is something to count. Nearly every row is one item, and
  // "1 of 1" on all of them buries the rows that are not.
  const of = (n: number) => (qty > 1 ? ` · ${n} of ${qty}` : '');

  if (!item.consignedAt) {
    return {
      key: 'not_received',
      // Not "Awaiting scan" any more. A shop's uploaded inventory sits here too
      // and nobody is going to scan it — staff accept the boxes when they
      // arrive. The word has to be true for both.
      label: 'Not yet received',
      tone: 'bg-gray-700/50 text-gray-300',
      title: 'Staff have not accepted this item yet. It is not in Square and cannot sell.',
    };
  }

  // Accepted, but the push did not land — `finish()` counts these as
  // `squareFailures`. It cannot sell, and nothing on this screen said so.
  if (!item.squareSynced) {
    return {
      key: 'not_in_square',
      label: 'Not in Square',
      tone: 'bg-amber-900/40 text-amber-300',
      title: 'Accepted, but it never reached Square. It cannot sell until it does — re-push it from here.',
    };
  }

  if (item.inStock > 0) {
    return {
      key: 'for_sale',
      label: `For sale${qty > 1 ? ` · ${item.inStock} of ${qty} left` : ''}`,
      tone: 'bg-green-900/40 text-green-400',
      title: 'In Square with stock on the floor.',
    };
  }

  return {
    key: 'sold',
    label: `Sold${of(item.soldCount)}`,
    tone: 'bg-blue-900/40 text-blue-300',
    title: 'In Square with nothing left.',
  };
}

export default function SwapItemsPanel({
  orgId, swapId, canManage, queryKeyPrefix, panelApi, selfService,
  showSearch = false, sellers, emptyMessage = 'No items found.', labelsPerItem = 1,
  tickets, toolbarExtra,
}: SwapItemsPanelProps) {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [printFilter, setPrintFilter] = useState<'' | 'not_printed' | 'printed'>('');
  const [stateFilter, setStateFilter] = useState<'' | ItemStateKey>('');
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<ItemResponse | null>(null);
  const [printingItem, setPrintingItem] = useState(false);
  const [showUnsupportedModal, setShowUnsupportedModal] = useState(false);
  const [pendingPhoto, setPendingPhoto] = useState<{ file: File; preview: string } | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const { printItem } = usePrinter();
  const [form, setForm] = useState<ItemFormData>(emptyForm);

  const [sellerFilter, setSellerFilter] = useState('');

  const queryKey = [queryKeyPrefix, orgId, swapId, query, sellerFilter];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => panelApi.fetchItems(swapId!, {
      ...(query ? { query } : {}),
      ...(sellerFilter ? { sellerId: sellerFilter } : {}),
    }),
    enabled: !!swapId,
  });

  const createMutation = useMutation({
    mutationFn: () => panelApi.createItem(swapId!, {
      categoryId: form.describer.categoryId!,
      attributes: toAttributeInputs(form.describer),
      description: form.description || undefined,
      priceCents: Math.round(parseFloat(form.priceDollars) * 100),
      quantity: 1,
      sellerId: form.sellerId || undefined,
      donateProceeds: form.donateProceeds,
      ...(tickets ? { sku: form.sku.trim() } : {}),
    }),
    onSuccess: (item) => {
      // The suggestion is derived from the items, so it is stale the moment one
      // is saved — without this the next add would offer the number just used.
      tickets?.onUsed();
      if (pendingPhoto && panelApi.uploadPhoto) {
        uploadPhotoMutation.mutate(
          { itemId: item.id, file: pendingPhoto.file },
          {
            onSuccess: () => { qc.invalidateQueries({ queryKey }); closeForm(); },
            onError: (err: unknown) => {
              qc.invalidateQueries({ queryKey });
              setPhotoError((err as Error)?.message ?? 'Photo upload failed. Item was saved.');
            },
          },
        );
      } else {
        qc.invalidateQueries({ queryKey });
        closeForm();
      }
    },
  });

  const patchMutation = useMutation({
    mutationFn: () => panelApi.patchItem(editItem!.id, {
      ...(form.describer.categoryId
        ? {
            categoryId: form.describer.categoryId,
            attributes: toAttributeInputs(form.describer),
          }
        : {}),
      description: form.description || null,
      priceCents: Math.round(parseFloat(form.priceDollars) * 100),
      quantity: parseInt(form.quantity, 10),
      sellerId: sellers ? (form.sellerId || null) : undefined,
      donateProceeds: form.donateProceeds,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey }); closeForm(); },
  });

  const deleteMutation = useMutation({
    mutationFn: (itemId: string) => panelApi.deleteItem(itemId),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  });

  const consignAll = useMutation({
    mutationFn: () => panelApi.consignAllForSeller!(swapId!, sellerFilter),
    // The rows are consigned before this answers, but their Square pushes are
    // still running behind it — so what comes back now will show some of them
    // as `Not in Square` until they land. Refetched again shortly after, which
    // is cheaper than making the operator wonder whether to press it twice.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      setTimeout(() => void qc.invalidateQueries({ queryKey }), 4000);
    },
  });

  const uploadPhotoMutation = useMutation({
    mutationFn: ({ itemId, file }: { itemId: string; file: File }) => panelApi.uploadPhoto!(itemId, file),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
    onError: (err: unknown) => setPhotoError((err as Error)?.message ?? 'Photo upload failed'),
  });

  const deletePhotoMutation = useMutation({
    mutationFn: ({ itemId, photoId }: { itemId: string; photoId: string }) => panelApi.deletePhoto!(itemId, photoId),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  });

  function openEdit(item: ItemResponse) {
    setEditItem(item);
    setForm({
      /**
       * Rebuilt from what the item stored, not from its name.
       *
       * An answer whose question the current tree no longer asks simply does not
       * come back, and saving drops it — the tree is the authority on what can be
       * said. An item with no category at all (one an importer created) opens with
       * the picker empty, and gets a description the first time anyone edits it.
       */
      describer: {
        categoryId: item.category?.id ?? null,
        answers: Object.fromEntries(
          item.attributes.map((a) => [
            a.attributeId,
            a.valueId
              ? { valueId: a.valueId }
              : { numberValue: a.numberValue !== null ? String(a.numberValue) : '' },
          ]),
        ),
      },
      description: item.description ?? '',
      priceDollars: (item.priceCents / 100).toFixed(2),
      quantity: String(item.originalQuantity),
      sellerId: item.seller?.id ?? '',
      // Carried so the shape is complete; editing never changes a ticket
      // number, because the ticket is physically on the goods.
      sku: item.sku,
      donateProceeds: item.donateProceeds,
    });
  }

  function closeForm() {
    setPendingPhoto(null);
    setPhotoError(null);
    setShowForm(false);
    setEditItem(null);
    setForm(emptyForm);
  }

  async function handlePrint(item: ItemResponse) {
    if (!isWebBluetoothSupported()) { setShowUnsupportedModal(true); return; }
    setPrintingItem(true);
    try {
      for (let i = 0; i < labelsPerItem; i++) {
        await printItem(item);
      }
      await panelApi.patchItem(item.id, { hasPrintedTag: true });
      qc.invalidateQueries({ queryKey });
    } catch (err: unknown) {
      if ((err as { name?: string })?.name !== 'NotFoundError')
        console.error('Print failed:', err);
    } finally {
      setPrintingItem(false);
    }
  }

  const isFormOpen = showForm || editItem !== null;
  const items = (data?.items ?? [])
    .filter((i) => printFilter === 'printed' ? i.hasPrintedTag : printFilter === 'not_printed' ? !i.hasPrintedTag : true)
    // Through `itemState`, not through the underlying fields again: a filter
    // that decided for itself what "sold" meant could disagree with the column
    // beside it, and the column is the one that had to be corrected.
    .filter((i) => (stateFilter ? itemState(i).key === stateFilter : true));

  if (!swapId) return null;
  if (isLoading) return <p className="text-gray-400 text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex gap-2 items-center">
          {showSearch && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, SKU, seller…"
              className="bg-surface-50 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-72"
            />
          )}
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as '' | ItemStateKey)}
            className="bg-surface-50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
          >
            <option value="">All states</option>
            {ITEM_STATE_FILTERS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {sellers && (
            <select
              value={sellerFilter}
              onChange={(e) => setSellerFilter(e.target.value)}
              aria-label="Filter by seller"
              className="bg-surface-50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white max-w-52"
            >
              <option value="">All sellers</option>
              {sellers.map((sl) => (
                <option key={sl.id} value={sl.id}>{sl.displayName}</option>
              ))}
            </select>
          )}
          <select
            value={printFilter}
            onChange={(e) => setPrintFilter(e.target.value as '' | 'not_printed' | 'printed')}
            className="bg-surface-50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
          >
            <option value="">All tags</option>
            <option value="not_printed">Not printed</option>
            <option value="printed">Printed</option>
          </select>
        </div>
        <div className="flex gap-2 items-center">
        {sellerFilter && panelApi.consignAllForSeller && (
          <ConsignAllButton
            sellerName={sellers?.find((sl) => sl.id === sellerFilter)?.displayName ?? 'this seller'}
            waiting={(data?.items ?? []).filter((i) => !i.consignedAt).length}
            total={data?.total ?? 0}
            pending={consignAll.isPending}
            result={consignAll.data}
            error={consignAll.error}
            onConsign={() => consignAll.mutate()}
          />
        )}
        {toolbarExtra}
        {canManage && (
          <button
            onClick={() => {
              setShowForm(true);
              setEditItem(null);
              // Pre-filled with the suggestion when there is one. Past the top
              // of the ranges it opens blank rather than refusing, because a
              // skipped ticket may still be in the box.
              setForm({
                ...emptyForm,
                sku: tickets?.suggested != null ? String(tickets.suggested) : '',
              });
            }}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium"
          >
            + Add Item
          </button>
        )}
        </div>
      </div>

      {/* Items table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 text-left border-b border-gray-800">
              <th className="pb-2 pr-4">SKU</th>
              <th className="pb-2 pr-4">Name</th>
              <th className="pb-2 pr-4">Price</th>
              {sellers && <th className="pb-2 pr-4">Seller</th>}
              <th className="pb-2 pr-4">State</th>
              <th className="pb-2 pr-4" title="Tag printed"><FontAwesomeIcon icon={faTagDuo} /></th>
              {canManage && <th className="pb-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={sellers ? 7 : 6} className="py-6 text-center text-gray-500 text-sm">{emptyMessage}</td></tr>
            )}
            {items.map((item) => (
              <tr key={item.id} className="border-b border-gray-900 hover:bg-surface-50">
                <td className="py-2 pr-4 font-mono text-gray-400 text-xs">{item.sku}</td>
                <td className="py-2 pr-4 text-white">
                  {item.name}
                  {item.donateProceeds && <span className="ml-1.5 text-xs" title="Donating proceeds to ski patrol">❤️</span>}
                </td>
                <td className="py-2 pr-4 text-gray-300">${(item.priceCents / 100).toFixed(2)}</td>
                {sellers && <td className="py-2 pr-4 text-gray-400">{item.seller?.displayName ?? '—'}</td>}
                <td className="py-2 pr-4">
                  {(() => {
                    const st = itemState(item);
                    return (
                      <span
                        title={st.title}
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${st.tone}`}
                      >
                        {st.label}
                      </span>
                    );
                  })()}
                </td>
                <td className="py-2 pr-4">
                  {item.hasPrintedTag
                    ? <FontAwesomeIcon icon={faTagDuo} className="text-green-500" title="Printed" />
                    : <FontAwesomeIcon icon={faTagDuo} className="text-amber-400" title="Not printed" />}
                </td>
                {canManage && (
                  <td className="py-2 flex gap-2 items-center">
                    <button onClick={() => openEdit(item)} className="text-xs text-brand-500 hover:underline">Edit</button>
                    {selfService && item.consignedAt ? (
                      // Said rather than hidden. A button that quietly vanishes
                      // once an item is accepted reads as a bug; this reads as
                      // a rule.
                      <span
                        className="text-xs text-gray-600 cursor-not-allowed"
                        title="This item has been accepted for sale. Ask at the counter to withdraw it."
                      >Delete</span>
                    ) : (
                      <button
                        onClick={() => { if (confirm(`Delete "${item.name}"?`)) deleteMutation.mutate(item.id); }}
                        className="text-xs text-red-500 hover:underline"
                      >Delete</button>
                    )}
                    {/* Hidden two ways, for the same reason twice over.
                        `tickets` is a seller working off an issued stack, and
                        `legacyTicket` is a single item checked in against a
                        pre-printed one: either way the tag is already on the
                        goods and came out of a box, so there is nothing a
                        printer could produce. Both check-in paths mark these
                        `hasPrintedTag`, which is what used to leave a Reprint
                        button offering to reproduce something we never made. */}
                    {tickets || item.legacyTicket ? null : item.hasPrintedTag ? (
                      <button
                        onClick={() => handlePrint(item)}
                        disabled={printingItem}
                        className="text-xs text-gray-400 hover:text-white flex items-center gap-1 disabled:opacity-40"
                        title="Reprint tag"
                      >
                        <FontAwesomeIcon icon={faRotateRightDuo} /> Reprint
                      </button>
                    ) : (
                      <button
                        onClick={() => handlePrint(item)}
                        disabled={printingItem}
                        className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1 disabled:opacity-40"
                        title="Print tag"
                      >
                        <FontAwesomeIcon icon={faPrintDuo} /> Label
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add / Edit modal */}
      {isFormOpen && canManage && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          {/*
            A capped column, not a box that grows.

            Describing a bike asks ten questions, which is taller than a laptop
            viewport — and a centred child that outgrows its container has its
            top pushed above the top of the screen, where nothing can scroll to
            reach it. So the height is capped and only the fields scroll.
            `min-h-0` on that middle region is what makes the scrolling work at
            all: a flex child defaults to min-height:auto and refuses to shrink
            below its content, so `overflow-y-auto` never engages without it.

            Keeping the buttons out of the scroll region is the other half —
            Save should not be something you have to go looking for.
          */}
          <form
            className="bg-surface-200 rounded-lg w-full max-w-md flex flex-col max-h-[calc(100vh-2rem)]"
            onSubmit={(e) => { e.preventDefault(); if (editItem) patchMutation.mutate(); else createMutation.mutate(); }}
          >
            <h2 className="text-white font-semibold px-6 pt-6 pb-4 shrink-0">{editItem ? 'Edit Item' : 'Add Item'}</h2>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 space-y-4">

            {tickets && !editItem && (
              <label className="block">
                <span className="block text-xs text-gray-400 mb-1">Ticket number</span>
                <input
                  autoFocus
                  value={form.sku}
                  onChange={(e) => setForm({ ...form, sku: e.target.value })}
                  // Selected rather than locked: the common case is accepting
                  // the suggestion, but a ticket found later has to be typeable.
                  onFocus={(e) => e.currentTarget.select()}
                  inputMode="numeric"
                  placeholder="e.g. 67169"
                  className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono"
                />
                <span className="block text-xs text-gray-500 mt-1">
                  {tickets.suggested !== null
                    ? `Next in ${describeRanges(tickets.ranges)}. Type another if this one was lost or you are using a different ticket.`
                    : `No next ticket — you have worked to the end of ${describeRanges(tickets.ranges)}. If you have found a skipped one, enter its number.`}
                </span>
              </label>
            )}

            <ItemDescriber
              orgId={orgId}
              value={form.describer}
              onChange={(describer) => setForm({ ...form, describer })}
              // Wider screen, so every question shows rather than the tail of
              // them collapsing behind "More detail".
              layout="grid"
              renderPreview={(name, { parts }) =>
                name ? <NamePreview name={name} parts={parts} /> : null
              }
            />
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Notes (optional)"
              rows={2}
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white resize-none"
            />
            {editItem ? (
              <div className="grid grid-cols-2 gap-3">
                <input
                  required
                  inputMode="decimal"
                  value={form.priceDollars}
                  onChange={(e) => {
                    const val = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*?)\./g, '$1');
                    setForm({ ...form, priceDollars: val });
                  }}
                  placeholder="Price ($)"
                  className="bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                />
                <input
                  required
                  type="number"
                  min="1"
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                  placeholder="Quantity"
                  className="bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                />
              </div>
            ) : (
              <input
                required
                inputMode="decimal"
                value={form.priceDollars}
                onChange={(e) => {
                  const val = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*?)\./g, '$1');
                  setForm({ ...form, priceDollars: val });
                }}
                placeholder="Price ($)"
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
              />
            )}

            {sellers && (
              <SearchableSelect
                value={form.sellerId}
                onChange={(v) => setForm({ ...form, sellerId: v })}
                options={sellers.map((s) => ({ value: s.id, label: s.displayName, sublabel: s.phone ?? '', keywords: s.email ?? '' }))}
                placeholder="No seller assigned"
                clearLabel="No seller assigned"
                emptyMessage="No sellers match."
              />
            )}

            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.donateProceeds}
                onChange={(e) => setForm({ ...form, donateProceeds: e.target.checked })}
                className="accent-brand-600"
              />
              <span className="text-gray-300">❤️ Donate proceeds to ski patrol</span>
            </label>

            {/* Photo — pending upload for new items */}
            {!editItem && panelApi.uploadPhoto && (
              <div className="space-y-2 pt-1 border-t border-gray-700">
                <p className="text-xs text-gray-400">Photo (optional)</p>
                {pendingPhoto ? (
                  <div className="flex items-center gap-3">
                    <img src={pendingPhoto.preview} className="w-16 h-16 object-cover rounded" alt="" />
                    <button
                      type="button"
                      onClick={() => setPendingPhoto(null)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >Remove</button>
                  </div>
                ) : (
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-400 hover:text-white">
                    <span className="bg-surface-100 border border-gray-700 rounded px-3 py-1.5 text-xs">Choose image…</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) {
                          const reader = new FileReader();
                          reader.onload = (ev) => setPendingPhoto({ file: f, preview: ev.target!.result as string });
                          reader.readAsDataURL(f);
                        }
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
              </div>
            )}

            {/* Photos — edit mode: view, add, delete */}
            {editItem && panelApi.uploadPhoto && panelApi.deletePhoto && (
              <div className="space-y-2 pt-1 border-t border-gray-700">
                <p className="text-xs text-gray-400">Photos</p>
                <div className="flex flex-wrap gap-2">
                  {editItem.photos.map((p) => (
                    <div key={p.id} className="relative">
                      <img src={p.url} className="w-16 h-16 object-cover rounded" alt="" />
                      <button
                        type="button"
                        className="absolute -top-1 -right-1 bg-red-600 text-white rounded-full w-4 h-4 text-xs flex items-center justify-center"
                        onClick={() => deletePhotoMutation.mutate({ itemId: editItem.id, photoId: p.id })}
                      >×</button>
                    </div>
                  ))}
                </div>
                <input
                  type="file"
                  accept="image/*"
                  className="text-xs text-gray-400"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadPhotoMutation.mutate({ itemId: editItem.id, file: f });
                    e.target.value = '';
                  }}
                />
              </div>
            )}

            {photoError && (
              <p className="text-xs text-red-400 pt-1">{photoError}</p>
            )}

            </div>

            <div className="flex gap-2 px-6 py-4 shrink-0 border-t border-gray-700">
              <button
                type="submit"
                disabled={createMutation.isPending || patchMutation.isPending || uploadPhotoMutation.isPending}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded py-1.5 disabled:opacity-40"
              >
                {editItem ? 'Save' : 'Add'}
              </button>
              <button type="button" onClick={closeForm} className="flex-1 bg-surface-100 text-gray-300 text-sm rounded py-1.5">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Printer selector modal */}
      {/* (removed — browser picker handles selection via PrinterContext) */}

      {/* Unsupported browser modal */}
      {showUnsupportedModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface-200 rounded-lg p-6 w-full max-w-sm space-y-4">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <FontAwesomeIcon icon={faTriangleExclamationDuo} className="text-amber-400" /> Printing Not Available
            </h2>
            <p className="text-gray-400 text-sm">
              Price tag printing requires <strong className="text-white">Chrome</strong> or{' '}
              <strong className="text-white">Edge</strong>. Firefox and Safari do not support
              WebBluetooth.
            </p>
            <button
              onClick={() => setShowUnsupportedModal(false)}
              className="w-full bg-surface-100 text-gray-300 text-sm rounded py-1.5"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
