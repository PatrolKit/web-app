import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { SellerResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';

interface SellerForm {
  name: string; phone: string; email: string;
  street: string; city: string; state: string; zip: string;
}

const emptyForm: SellerForm = { name: '', phone: '', email: '', street: '', city: '', state: '', zip: '' };

export default function SellersPage() {
  const { orgId, perms, selectedSwap } = useOutletContext<SkiSwapContext>();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [editSeller, setEditSeller] = useState<SellerResponse | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<SellerForm>(emptyForm);

  const { data: sellers = [], isLoading } = useQuery({
    queryKey: ['ski-swap/sellers', orgId, query],
    queryFn: () => api.skiSwap.listSellers(orgId, query || undefined),
    enabled: !!orgId,
  });

  const createMutation = useMutation({
    mutationFn: () => api.skiSwap.createSeller(orgId, {
      name: form.name, phone: form.phone,
      email: form.email || undefined, street: form.street || undefined,
      city: form.city || undefined, state: form.state || undefined, zip: form.zip || undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ski-swap/sellers', orgId] }); setShowForm(false); setForm(emptyForm); },
  });

  const patchMutation = useMutation({
    mutationFn: (s: SellerResponse) => api.skiSwap.patchSeller(orgId, s.id, {
      name: form.name, phone: form.phone,
      email: form.email || null, street: form.street || null,
      city: form.city || null, state: form.state || null, zip: form.zip || null,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ski-swap/sellers', orgId] }); setEditSeller(null); setForm(emptyForm); },
  });

  const deleteMutation = useMutation({
    mutationFn: (sellerId: string) => api.skiSwap.deleteSeller(orgId, sellerId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ski-swap/sellers', orgId] }),
  });

  function openEdit(s: SellerResponse) {
    setEditSeller(s);
    setForm({ name: s.name, phone: s.phone, email: s.email ?? '', street: s.street ?? '', city: s.city ?? '', state: s.state ?? '', zip: s.zip ?? '' });
  }

  const canManage = perms.has('ski_swap:manage');

  if (!selectedSwap) {
    return (
      <p className="text-gray-400 text-sm">
        {perms.has('ski_swap:admin')
          ? "No active swaps found. Create one on the 'Swaps' page."
          : 'No active swaps found. Contact your swap administrator to create one.'}
      </p>
    );
  }

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name / phone…"
          className="bg-surface-50 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-48" />
        {canManage && (
          <button onClick={() => { setShowForm(true); setEditSeller(null); setForm(emptyForm); }}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">
            + Add Seller
          </button>
        )}
      </div>

      {(showForm || editSeller) && canManage && (
        <form onSubmit={(e) => { e.preventDefault(); editSeller ? patchMutation.mutate(editSeller) : createMutation.mutate(); }}
          className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
          <h3 className="text-white font-medium">{editSeller ? 'Edit Seller' : 'New Seller'}</h3>
          <div className="grid grid-cols-2 gap-3">
            {([['name', 'Name *', true], ['phone', 'Phone *', true], ['email', 'Email', false], ['street', 'Street', false], ['city', 'City', false], ['state', 'State', false], ['zip', 'ZIP', false]] as [keyof SellerForm, string, boolean][]).map(([key, label, required]) => (
              <input key={key} required={required} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                placeholder={label} className="bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
            ))}
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={createMutation.isPending || patchMutation.isPending}
              className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">
              {editSeller ? 'Save' : 'Create'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditSeller(null); }}
              className="text-gray-400 hover:text-white text-sm px-3 py-2">Cancel</button>
          </div>
        </form>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-400 text-left border-b border-gray-800">
            <th className="pb-2 pr-4">Name</th>
            <th className="pb-2 pr-4">Phone</th>
            <th className="pb-2 pr-4">Email</th>
            {canManage && <th className="pb-2">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {sellers.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-gray-500 text-sm">No sellers found.</td></tr>}
          {sellers.map((s) => (
            <tr key={s.id} className="border-b border-gray-900 hover:bg-surface-50">
              <td className="py-2 pr-4 text-white">{s.name}</td>
              <td className="py-2 pr-4 text-gray-400 font-mono text-xs">{s.phone}</td>
              <td className="py-2 pr-4 text-gray-400">{s.email ?? '—'}</td>
              {canManage && (
                <td className="py-2 flex gap-2">
                  <button onClick={() => openEdit(s)} className="text-xs text-brand-500 hover:underline">Edit</button>
                  <button onClick={() => { if (confirm(`Delete "${s.name}"?`)) deleteMutation.mutate(s.id); }}
                    className="text-xs text-red-500 hover:underline">Delete</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
