import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPrint as faPrintDuo, faRotateRight as faRotateRightDuo, faTag as faTagDuo, faTriangleExclamation as faTriangleExclamationDuo } from '@fortawesome/pro-duotone-svg-icons';
import type { ItemResponse, SellerResponse } from '../../lib/api.types';
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
  showSearch?: boolean;
  sellers?: SellerResponse[];
  emptyMessage?: string;
}

// ─── Form state ───────────────────────────────────────────────────────────────

interface ItemFormData {
  name: string;
  description: string;
  priceDollars: string;
  quantity: string;
  sellerId: string;
  donateProceeds: boolean;
}

const emptyForm: ItemFormData = { name: '', description: '', priceDollars: '', quantity: '1', sellerId: '', donateProceeds: false };

// ─── Component ────────────────────────────────────────────────────────────────

export default function SwapItemsPanel({
  orgId, swapId, canManage, queryKeyPrefix, panelApi,
  showSearch = false, sellers, emptyMessage = 'No items found.',
}: SwapItemsPanelProps) {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [sellerFilter, setSellerFilter] = useState('');
  const [printFilter, setPrintFilter] = useState<'' | 'not_printed' | 'printed'>('');
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<ItemResponse | null>(null);
  const [printingItem, setPrintingItem] = useState(false);
  const [showUnsupportedModal, setShowUnsupportedModal] = useState(false);

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
      quantity: parseInt(form.quantity, 10),
      sellerId: form.sellerId || undefined,
      donateProceeds: form.donateProceeds,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey }); closeForm(); },
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
      donateProceeds: item.donateProceeds,
    });
  }

  function closeForm() { setShowForm(false); setEditItem(null); setForm(emptyForm); }

  async function handlePrint(item: ItemResponse) {
    if (!isWebBluetoothSupported()) { setShowUnsupportedModal(true); return; }
    setPrintingItem(true);
    try {
      await printItem(item);
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
    .filter((i) => !sellerFilter || i.seller?.id === sellerFilter)
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
              placeholder="Search name / SKU…"
              className="bg-surface-50 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-48"
            />
          )}
          {sellers && sellers.length > 0 && (
            <select
              value={sellerFilter}
              onChange={(e) => setSellerFilter(e.target.value)}
              className="bg-surface-50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
            >
              <option value="">All sellers</option>
              {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
        {canManage && (
          <button
            onClick={() => { setShowForm(true); setEditItem(null); setForm(emptyForm); }}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium"
          >
            + Add Item
          </button>
        )}
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
                {sellers && <td className="py-2 pr-4 text-gray-400">{item.seller?.name ?? '—'}</td>}
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
                    {item.hasPrintedTag ? (
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
                        <FontAwesomeIcon icon={faPrintDuo} /> Print
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
            onSubmit={(e) => { e.preventDefault(); editItem ? patchMutation.mutate() : createMutation.mutate(); }}
          >
            <h2 className="text-white font-semibold">{editItem ? 'Edit Item' : 'Add Item'}</h2>

            <input
              required
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus={!editItem}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Name"
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
            />
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Description (optional)"
              rows={2}
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white resize-none"
            />
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

            {sellers && (
              <select
                value={form.sellerId}
                onChange={(e) => setForm({ ...form, sellerId: e.target.value })}
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
              >
                <option value="">No seller assigned</option>
                {sellers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.phone})</option>)}
              </select>
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

            {/* Photos — only shown in edit mode when upload/delete functions are provided */}
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

            <div className="flex gap-2 pt-2">
              <button
                type="submit"
                disabled={createMutation.isPending || patchMutation.isPending}
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
