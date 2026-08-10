import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faUser, faBuilding } from '@fortawesome/free-solid-svg-icons';
import { api } from '../../lib/api';
import type { SellerResponse, BusinessSellerMember } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import SellerImportModal from './SellerImportModal';

interface SellerForm {
  type: 'individual' | 'business' | '';
  name: string; phone: string; email: string;
  street: string; city: string; state: string; zip: string;
  payoutMethod: string;
  payoutIdentifierType: string;
  payoutIdentifier: string;
}

const emptyForm: SellerForm = {
  type: '', name: '', phone: '', email: '',
  street: '', city: '', state: '', zip: '',
  payoutMethod: 'CHECK', payoutIdentifierType: '', payoutIdentifier: '',
};

export default function SellersPage() {
  const { orgId, perms } = useOutletContext<SkiSwapContext>();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'individual' | 'business'>('all');
  const [editSeller, setEditSeller] = useState<SellerResponse | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [form, setForm] = useState<SellerForm>(emptyForm);
  const [sortKey, setSortKey] = useState<keyof SellerResponse>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  function handleSort(key: keyof SellerResponse) {
    if (key === sortKey) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }

  function SortHeader({ label, field }: { label: string; field: keyof SellerResponse }) {
    const active = sortKey === field;
    return (
      <th
        className="pb-2 pr-4 cursor-pointer select-none whitespace-nowrap"
        onClick={() => handleSort(field)}
      >
        <span className={active ? 'text-white' : 'text-gray-400'}>{label}</span>
        <span className="ml-1 text-gray-600">{active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
      </th>
    );
  }

  const { data: sellers = [], isLoading } = useQuery({
    queryKey: ['ski-swap/sellers', orgId],
    // Fetch all sellers once; filtering is done client-side so the search input stays focused
    queryFn: () => api.skiSwap.listSellers(orgId),
    enabled: !!orgId,
    staleTime: 30_000,
  });

  const isAdmin = perms.has('ski_swap:admin');
  const { data: businessMembers = [] } = useQuery<BusinessSellerMember[]>({
    queryKey: ['ski-swap/business-sellers', orgId],
    queryFn: () => api.skiSwap.listBusinessSellers(orgId),
    enabled: !!orgId && isAdmin && typeFilter === 'business',
    staleTime: 30_000,
  });
  // Build a map from email → member for quick lookup in the table
  const memberByEmail = new Map(businessMembers.map((m) => [m.email.toLowerCase(), m]));

  const inviteMutation = useMutation({
    mutationFn: () => api.skiSwap.inviteBusinessSeller(orgId, {
      name: form.name,
      email: form.email,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ski-swap/sellers', orgId] });
      qc.invalidateQueries({ queryKey: ['ski-swap/business-sellers', orgId] });
      setShowForm(false);
      setForm(emptyForm);
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: 'active' | 'disabled' }) =>
      api.skiSwap.setBusinessSellerStatus(orgId, userId, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ski-swap/business-sellers', orgId] }),
  });

  const createMutation = useMutation({
    mutationFn: () => api.skiSwap.createSeller(orgId, {
      type: form.type as 'individual' | 'business', name: form.name, phone: form.phone,
      city: form.city || undefined, state: form.state || undefined, zip: form.zip || undefined,
      payoutMethod: (form.payoutMethod || undefined) as never,
      payoutIdentifierType: (form.payoutIdentifierType || undefined) as never,
      payoutIdentifier: form.payoutIdentifier || undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ski-swap/sellers', orgId] }); setShowForm(false); setForm(emptyForm); },
  });

  const patchMutation = useMutation({
    mutationFn: (s: SellerResponse) => api.skiSwap.patchSeller(orgId, s.id, {
      type: (form.type || undefined) as 'individual' | 'business' | undefined, name: form.name, phone: form.phone,
      city: form.city || null, state: form.state || null, zip: form.zip || null,
      payoutMethod: (form.payoutMethod || null) as never,
      payoutIdentifierType: (form.payoutIdentifierType || null) as never,
      payoutIdentifier: form.payoutIdentifier || null,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ski-swap/sellers', orgId] }); setEditSeller(null); setForm(emptyForm); },
  });

  const deleteMutation = useMutation({
    mutationFn: (sellerId: string) => api.skiSwap.deleteSeller(orgId, sellerId),
    onSuccess: (_, sellerId) => {
      qc.setQueryData<SellerResponse[]>(['ski-swap/sellers', orgId], (old) =>
        old?.filter((s) => s.id !== sellerId) ?? [],
      );
      qc.invalidateQueries({ queryKey: ['ski-swap/sellers', orgId] });
      qc.invalidateQueries({ queryKey: ['ski-swap/business-sellers', orgId] });
    },
  });

  function openEdit(s: SellerResponse) {
    setEditSeller(s);
    setForm({
      type: s.type, name: s.name, phone: s.phone, email: s.email ?? '',
      street: s.street ?? '', city: s.city ?? '', state: s.state ?? '', zip: s.zip ?? '',
      payoutMethod: s.payoutMethod ?? '', payoutIdentifierType: s.payoutIdentifierType ?? '',
      payoutIdentifier: s.payoutIdentifier ?? '',
    });
  }

  const canManage = perms.has('ski_swap:manage');

  const showingBusinessFilter = typeFilter === 'business';

  const filtered = sellers.filter((s) => {
    const q = search.toLowerCase();
    const matchesSearch = !q || s.name.toLowerCase().includes(q) || s.phone.includes(q) || (s.email ?? '').toLowerCase().includes(q);
    const matchesType = typeFilter === 'all' || s.type === typeFilter;
    return matchesSearch && matchesType;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone, or email…"
            className="bg-surface-50 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-56"
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
            className="bg-surface-50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
          >
            <option value="all">All types</option>
            <option value="individual">Individual</option>
            <option value="business">Business</option>
          </select>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <button onClick={() => setShowImport(true)}
              className="bg-surface-100 hover:bg-surface-200 text-white px-4 py-2 rounded text-sm font-medium">
              Import CSV
            </button>
            <button onClick={() => { setShowForm(true); setEditSeller(null); setForm(emptyForm); }}
              className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">
              + Add Seller
            </button>
          </div>
        )}
      </div>

      {(showForm || editSeller) && canManage && (
        <form onSubmit={(e) => {
          e.preventDefault();
          if (editSeller) patchMutation.mutate(editSeller);
          else if (form.type === 'business') inviteMutation.mutate();
          else createMutation.mutate();
        }}
          className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
          <h3 className="text-white font-medium">{editSeller ? 'Edit Seller' : 'New Seller'}</h3>

          {/* Step 1 — type picker (new sellers only) */}
          {!editSeller && form.type === '' && (
            <div className="flex gap-3 pt-1">
              <button type="button"
                onClick={() => setForm({ ...form, type: 'individual' })}
                className="flex-1 flex flex-col items-center gap-1.5 py-4 border border-gray-600 rounded-lg hover:border-brand-500 hover:bg-brand-900/10 text-gray-300 hover:text-white transition">
                <FontAwesomeIcon icon={faUser} className="text-lg" />
                <span className="text-sm font-medium">Individual</span>
              </button>
              <button type="button"
                onClick={() => setForm({ ...form, type: 'business' })}
                className="flex-1 flex flex-col items-center gap-1.5 py-4 border border-gray-600 rounded-lg hover:border-blue-500 hover:bg-blue-900/10 text-gray-300 hover:text-white transition">
                <FontAwesomeIcon icon={faBuilding} className="text-lg" />
                <span className="text-sm font-medium">Business</span>
              </button>
            </div>
          )}

          {/* Step 2a — Individual fields */}
          {(editSeller || form.type === 'individual') && (
            <>
              {!editSeller && (
                <button type="button" onClick={() => setForm({ ...form, type: '' })}
                  className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1">
                  <FontAwesomeIcon icon={faUser} className="w-3" /> Individual
                  <span className="ml-1 underline">Change</span>
                </button>
              )}
              <div className="grid grid-cols-2 gap-3">
                {([['name', 'Name *', true], ['phone', 'Phone *', true], ['email', 'Email', false], ['street', 'Street', false], ['city', 'City', false], ['state', 'State', false], ['zip', 'ZIP', false]] as [keyof SellerForm, string, boolean][]).map(([key, label, required]) => (
                  <input key={key} required={required} value={form[key] as string} onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    placeholder={label} className="bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
                ))}
              </div>
              <div className="space-y-2 pt-1 border-t border-gray-700">
                <p className="text-gray-400 text-xs uppercase">Payout</p>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-gray-400 text-xs">Method</span>
                    <select value={form.payoutMethod} onChange={(e) => setForm({ ...form, payoutMethod: e.target.value, payoutIdentifierType: '', payoutIdentifier: '' })}
                      className="mt-0.5 w-full bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white">
                      <option value="">— not set —</option>
                      <option value="PAYPAL">PayPal</option>
                      <option value="VENMO">Venmo</option>
                      <option value="CHECK">Check</option>
                      <option value="DONATE">Donate</option>
                    </select>
                  </label>
                  {form.payoutMethod && form.payoutMethod !== 'CHECK' && form.payoutMethod !== 'DONATE' && (
                    <label className="block">
                      <span className="text-gray-400 text-xs">Identifier type</span>
                      <select value={form.payoutIdentifierType} onChange={(e) => setForm({ ...form, payoutIdentifierType: e.target.value, payoutIdentifier: '' })}
                        className="mt-0.5 w-full bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white">
                        <option value="">— select —</option>
                        <option value="EMAIL">Email</option>
                        <option value="PHONE">Phone</option>
                        <option value="USER_HANDLE">User handle</option>
                      </select>
                    </label>
                  )}
                  {form.payoutIdentifierType && (
                    <input value={form.payoutIdentifier} onChange={(e) => setForm({ ...form, payoutIdentifier: e.target.value })}
                      placeholder={form.payoutIdentifierType === 'EMAIL' ? 'user@example.com' : form.payoutIdentifierType === 'PHONE' ? '555-123-4567' : '@handle'}
                      className="col-span-2 bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
                  )}
                </div>
              </div>
            </>
          )}

          {/* Step 2b — Business: name + email only */}
          {!editSeller && form.type === 'business' && (
            <>
              <button type="button" onClick={() => setForm({ ...form, type: '' })}
                className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1">
                <FontAwesomeIcon icon={faBuilding} className="w-3" /> Business
                <span className="ml-1 underline">Change</span>
              </button>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Business name *"
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
              <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="Email address *"
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
              <p className="text-xs text-gray-500">A magic-link onboarding email will be sent to this address.</p>
            </>
          )}

          {form.type !== '' && (
            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={createMutation.isPending || patchMutation.isPending || inviteMutation.isPending}
                className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium disabled:opacity-40">
                {editSeller ? 'Save' : form.type === 'business' ? 'Send Invite' : 'Create'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setEditSeller(null); setForm(emptyForm); }}
                className="text-gray-400 hover:text-white text-sm px-3 py-2">Cancel</button>
            </div>
          )}
          {form.type === '' && (
            <button type="button" onClick={() => { setShowForm(false); setEditSeller(null); }}
              className="text-gray-400 hover:text-white text-sm px-3 py-1">Cancel</button>
          )}
        </form>
      )}

      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-400 text-left border-b border-gray-800">
            <th className="pb-2 pr-2 w-6"></th>
            <SortHeader label="Name"   field="name" />
            <SortHeader label="Phone"  field="phone" />
            <SortHeader label="Email"  field="email" />
            <SortHeader label="Street" field="street" />
            <SortHeader label="City"   field="city" />
            <SortHeader label="State"  field="state" />
            <SortHeader label="ZIP"    field="zip" />            {showingBusinessFilter && isAdmin && <th className="pb-2">Access</th>}            {canManage && <th className="pb-2">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {sellers.length === 0 && (
            <tr>
              <td colSpan={9} className="py-12 text-center">
                <div className="text-4xl mb-3">🎿</div>
                <p className="text-gray-400 text-sm">No sellers yet — the mountain awaits.</p>
              </td>
            </tr>
          )}
          {sellers.length > 0 && filtered.length === 0 && (
            <tr>
              <td colSpan={9} className="py-12 text-center">
                <div className="text-4xl mb-3">🔍</div>
                <p className="text-gray-400 text-sm">No sellers match your search. Maybe they're still on the lift.</p>
              </td>
            </tr>
          )}
          {filtered
            .sort((a, b) => {
              const av = (a[sortKey] ?? '') as string;
              const bv = (b[sortKey] ?? '') as string;
              return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
            })
            .map((s) => (
            <tr key={s.id} className="border-b border-gray-900 hover:bg-surface-50">
              <td className="py-2 pr-2 text-gray-500">
                <FontAwesomeIcon icon={s.type === 'business' ? faBuilding : faUser} className="w-3.5" title={s.type} />
              </td>
              <td className="py-2 pr-4 text-white">{s.name}</td>
              <td className="py-2 pr-4 text-gray-400 font-mono text-xs">{s.phone}</td>
              <td className="py-2 pr-4 text-gray-400">{s.email ?? '—'}</td>
              <td className="py-2 pr-4 text-gray-400">{s.street ?? '—'}</td>
              <td className="py-2 pr-4 text-gray-400">{s.city ?? '—'}</td>
              <td className="py-2 pr-4 text-gray-400">{s.state ?? '—'}</td>
              <td className="py-2 pr-4 text-gray-400 font-mono text-xs">{s.zip ?? '—'}</td>
              {canManage && (
                <td className="py-2 flex gap-2">
                  <button onClick={() => openEdit(s)} className="text-xs text-brand-500 hover:underline">Edit</button>
                  {s.type !== 'business' && (
                    <button onClick={() => { if (confirm(`Delete "${s.name}"?`)) deleteMutation.mutate(s.id); }}
                      className="text-xs text-red-500 hover:underline">Delete</button>
                  )}
                </td>
              )}
              {showingBusinessFilter && isAdmin && (() => {
                const member = memberByEmail.get((s.email ?? '').toLowerCase());
                if (!member) return <td key="access" className="py-2 text-xs text-gray-600">—</td>;
                const active = member.status === 'active';
                return (
                  <td key="access" className="py-2">
                    <button
                      onClick={() => statusMutation.mutate({ userId: member.userId, status: active ? 'disabled' : 'active' })}
                      className={`text-xs px-2 py-0.5 rounded ${active ? 'bg-green-900 text-green-300 hover:bg-red-900 hover:text-red-300' : 'bg-red-900 text-red-300 hover:bg-green-900 hover:text-green-300'}`}
                    >
                      {active ? 'Active' : 'Disabled'}
                    </button>
                  </td>
                );
              })()}
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {showImport && (
        <SellerImportModal
          orgId={orgId}
          onClose={() => setShowImport(false)}
          onDone={() => { qc.invalidateQueries({ queryKey: ['ski-swap/sellers', orgId] }); }}
        />
      )}
    </div>
  );
}
