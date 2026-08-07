import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ItemResponse, SellerResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';

interface ItemFormData {
  name: string;
  description: string;
  priceDollars: string;
  quantity: string;
  sellerId: string;
  donateProceeds: boolean;
}

const emptyForm: ItemFormData = { name: '', description: '', priceDollars: '', quantity: '1', sellerId: '', donateProceeds: false };

export default function ItemsPage() {
  const { orgId, perms, selectedSwap } = useOutletContext<SkiSwapContext>();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [sellerFilter, setSellerFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<ItemResponse | null>(null);
  const [form, setForm] = useState<ItemFormData>(emptyForm);

  const swapId = selectedSwap?.id ?? '';

  const { data, isLoading } = useQuery({
    queryKey: ['ski-swap/items', orgId, swapId, query],
    queryFn: () => api.skiSwap.listItems(orgId, swapId, { query: query || undefined }),
    enabled: !!swapId,
  });

  const { data: sellers = [] } = useQuery<SellerResponse[]>({
    queryKey: ['ski-swap/sellers', orgId],
    queryFn: () => api.skiSwap.listSellers(orgId),
    enabled: !!orgId && perms.has('ski_swap:manage'),
  });

  const createMutation = useMutation({
    mutationFn: () => api.skiSwap.createItem(orgId, swapId, {
      name: form.name,
      description: form.description || undefined,
      priceCents: Math.round(parseFloat(form.priceDollars) * 100),
      quantity: parseInt(form.quantity, 10),
      sellerId: form.sellerId || undefined,
      donateProceeds: form.donateProceeds,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ski-swap/items', orgId, swapId] }); setShowForm(false); setForm(emptyForm); },
  });

  const patchMutation = useMutation({
    mutationFn: (item: ItemResponse) => api.skiSwap.patchItem(orgId, swapId, item.id, {
      name: form.name,
      description: form.description || null,
      priceCents: Math.round(parseFloat(form.priceDollars) * 100),
      quantity: parseInt(form.quantity, 10),
      sellerId: form.sellerId || null,
      donateProceeds: form.donateProceeds,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ski-swap/items', orgId, swapId] }); setEditItem(null); setForm(emptyForm); },
  });

  const deleteMutation = useMutation({
    mutationFn: (itemId: string) => api.skiSwap.deleteItem(orgId, swapId, itemId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ski-swap/items', orgId, swapId] }),
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

  const items = (data?.items ?? []).filter((i) => !sellerFilter || i.seller?.id === sellerFilter);

  if (!swapId) {
    return (
      <p className="text-gray-400 text-sm">
        {perms.has('ski_swap:admin')
          ? "No active swaps found. Create one on the 'Swaps' page."
          : 'No active swaps found. Contact your swap administrator to create one.'}
      </p>
    );
  }
  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  const canManage = perms.has('ski_swap:manage');

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name / SKU…"
            className="bg-surface-50 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-48"
          />
          <select
            value={sellerFilter}
            onChange={(e) => setSellerFilter(e.target.value)}
            className="bg-surface-50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
          >
            <option value="">All sellers</option>
            {sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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

      {/* Add / Edit form */}
      {(showForm || editItem) && canManage && (
        <form
          onSubmit={(e) => { e.preventDefault(); editItem ? patchMutation.mutate(editItem) : createMutation.mutate(); }}
          className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3"
        >
          <h3 className="text-white font-medium">{editItem ? 'Edit Item' : 'New Item'}</h3>
          <div className="grid grid-cols-2 gap-3">
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Name" className="col-span-2 bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Description (optional)" rows={2}
              className="col-span-2 bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white resize-none" />
            <input required type="number" min="0.01" step="0.01" value={form.priceDollars}
              onChange={(e) => setForm({ ...form, priceDollars: e.target.value })}
              placeholder="Price ($)" className="bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
            <input required type="number" min="1" value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              placeholder="Quantity" className="bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
            <select value={form.sellerId} onChange={(e) => setForm({ ...form, sellerId: e.target.value })}
              className="col-span-2 bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white">
              <option value="">No seller assigned</option>
              {sellers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.phone})</option>)}
            </select>
            <label className="col-span-2 flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" checked={form.donateProceeds} onChange={(e) => setForm({ ...form, donateProceeds: e.target.checked })} className="accent-brand-600" />
              <span className="text-gray-300">❤️ Donate proceeds to ski patrol</span>
            </label>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={createMutation.isPending || patchMutation.isPending}
              className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">
              {editItem ? 'Save' : 'Create'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditItem(null); }}
              className="text-gray-400 hover:text-white text-sm px-3 py-2">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Items table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 text-left border-b border-gray-800">
              <th className="pb-2 pr-4">SKU</th>
              <th className="pb-2 pr-4">Name</th>
              <th className="pb-2 pr-4">Price</th>
              <th className="pb-2 pr-4">Seller</th>
              <th className="pb-2 pr-4">In Stock</th>
              <th className="pb-2 pr-4">Sold</th>
              {canManage && <th className="pb-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={7} className="py-6 text-center text-gray-500 text-sm">No items found.</td></tr>
            )}
            {items.map((item) => (
              <tr key={item.id} className="border-b border-gray-900 hover:bg-surface-50">
                <td className="py-2 pr-4 font-mono text-gray-400 text-xs">{item.sku}</td>
                <td className="py-2 pr-4 text-white">
                  {item.name}
                  {item.donateProceeds && <span className="ml-1.5 text-xs" title="Donating proceeds to ski patrol">❤️</span>}
                </td>
                <td className="py-2 pr-4 text-gray-300">${(item.priceCents / 100).toFixed(2)}</td>
                <td className="py-2 pr-4 text-gray-400">{item.seller?.name ?? '—'}</td>
                <td className="py-2 pr-4 text-gray-300">{item.inStock}</td>
                <td className="py-2 pr-4 text-gray-300">{item.soldCount}</td>
                {canManage && (
                  <td className="py-2 flex gap-2">
                    <button onClick={() => openEdit(item)} className="text-xs text-brand-500 hover:underline">Edit</button>
                    <button
                      onClick={() => { if (confirm(`Delete "${item.name}"?`)) deleteMutation.mutate(item.id); }}
                      className="text-xs text-red-500 hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
