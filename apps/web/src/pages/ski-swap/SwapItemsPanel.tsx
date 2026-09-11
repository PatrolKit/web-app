import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPrint as faPrintDuo, faRotateRight as faRotateRightDuo, faTag as faTagDuo, faTriangleExclamation as faTriangleExclamationDuo } from '@fortawesome/pro-duotone-svg-icons';
import type { ItemResponse, SellerResponse } from '../../lib/api.types';
import SearchableSelect from '../../components/SearchableSelect';
import { usePrinter } from '../../contexts/PrinterContext';
import { isWebBluetoothSupported } from '../../lib/printing/PhomemoPrinterService';

// ─── API adapter interface ────────────────────────────────────────────────────

export interface SwapItemsPanelApi {
  fetchItems: (swapId: string, opts?: { query?: string }) => Promise<{ items: ItemResponse[]; total: number }>;
  createItem: (swapId: string, data: CreateItemInput) => Promise<ItemResponse>;
  patchItem: (itemId: string, data: PatchItemInput) => Promise<ItemResponse>;
  deleteItem: (itemId: string) => Promise<void>;
  uploadPhoto?: (itemId: string, file: File) => Promise<{ id: string; url: string }>;
  deletePhoto?: (itemId: string, photoId: string) => Promise<void>;
}

export interface CreateItemInput {
  /** A ticket number, for a seller on issued tickets. Absent otherwise. */
  sku?: string;
  name: string;
  description?: string;
  priceCents: number;
  quantity: number;
  sellerId?: string;
  donateProceeds?: boolean;
}

export interface PatchItemInput {
  name?: string;
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
  showSearch?: boolean;
  sellers?: SellerResponse[];
  emptyMessage?: string;
  labelsPerItem?: number;
  /** Rendered beside Add item. The staff page uses it for the seller import. */
  toolbarExtra?: ReactNode;
}

// ─── Form state ───────────────────────────────────────────────────────────────

interface ItemFormData {
  name: string;
  description: string;
  priceDollars: string;
  quantity: string;
  sellerId: string;
  donateProceeds: boolean;
  /** The ticket on the item, for a seller on issued tickets. */
  sku: string;
}

const emptyForm: ItemFormData = { name: '', description: '', priceDollars: '', quantity: '1', sellerId: '', donateProceeds: false, sku: '' };

/** "67000–67499", or "67000–67499, 68000–68499" for a shop with two pads. */
function describeRanges(ranges: { startNumber: number; endNumber: number }[]): string {
  return ranges.map((r) => `${r.startNumber}–${r.endNumber}`).join(', ');
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SwapItemsPanel({
  orgId, swapId, canManage, queryKeyPrefix, panelApi,
  showSearch = false, sellers, emptyMessage = 'No items found.', labelsPerItem = 1,
  tickets, toolbarExtra,
}: SwapItemsPanelProps) {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [printFilter, setPrintFilter] = useState<'' | 'not_printed' | 'printed'>('');
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<ItemResponse | null>(null);
  const [printingItem, setPrintingItem] = useState(false);
  const [showUnsupportedModal, setShowUnsupportedModal] = useState(false);
  const [pendingPhoto, setPendingPhoto] = useState<{ file: File; preview: string } | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const { printItem } = usePrinter();
  const [form, setForm] = useState<ItemFormData>(emptyForm);

  const queryKey = [queryKeyPrefix, orgId, swapId, query];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => panelApi.fetchItems(swapId!, query ? { query } : undefined),
    enabled: !!swapId,
  });

  const createMutation = useMutation({
    mutationFn: () => panelApi.createItem(swapId!, {
      name: form.name,
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
      name: form.name,
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
      name: item.name,
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
    .filter((i) => printFilter === 'printed' ? i.hasPrintedTag : printFilter === 'not_printed' ? !i.hasPrintedTag : true);

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
              <th className="pb-2 pr-4">In Stock</th>
              <th className="pb-2 pr-4">Sold</th>
              <th className="pb-2 pr-4" title="Tag printed"><FontAwesomeIcon icon={faTagDuo} /></th>
              {canManage && <th className="pb-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={sellers ? 8 : 7} className="py-6 text-center text-gray-500 text-sm">{emptyMessage}</td></tr>
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
                <td className="py-2 pr-4 text-gray-300">{item.inStock}</td>
                <td className="py-2 pr-4 text-gray-300">{item.soldCount}</td>
                <td className="py-2 pr-4">
                  {item.hasPrintedTag
                    ? <FontAwesomeIcon icon={faTagDuo} className="text-green-500" title="Printed" />
                    : <FontAwesomeIcon icon={faTagDuo} className="text-amber-400" title="Not printed" />}
                </td>
                {canManage && (
                  <td className="py-2 flex gap-2 items-center">
                    <button onClick={() => openEdit(item)} className="text-xs text-brand-500 hover:underline">Edit</button>
                    <button
                      onClick={() => { if (confirm(`Delete "${item.name}"?`)) deleteMutation.mutate(item.id); }}
                      className="text-xs text-red-500 hover:underline"
                    >Delete</button>
                    {/* Hidden for a seller on issued tickets: the tag is
                        already on the goods, and there is no printer to send
                        one to. */}
                    {tickets ? null : item.hasPrintedTag ? (
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <form
            className="bg-surface-200 rounded-lg p-6 w-full max-w-md space-y-4"
            onSubmit={(e) => { e.preventDefault(); if (editItem) patchMutation.mutate(); else createMutation.mutate(); }}
          >
            <h2 className="text-white font-semibold">{editItem ? 'Edit Item' : 'Add Item'}</h2>

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

            <input
              required={!tickets}
              autoFocus={!editItem && !tickets}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={tickets ? 'Name (optional)' : 'Name'}
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
            />
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Description (optional)"
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

            <div className="flex gap-2 pt-2">
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
