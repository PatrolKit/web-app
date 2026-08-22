import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faUser, faBuilding, faPrint, faCheckCircle, faCircle } from '@fortawesome/free-solid-svg-icons';
import { api } from '../../lib/api';
import type { SellerResponse, BusinessSellerMember } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import SellerImportModal from './SellerImportModal';
import PrintReceiptModal from './PrintReceiptModal';

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
  const { orgId, perms, selectedSwap } = useOutletContext<SkiSwapContext>();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'individual' | 'business'>('all');
  const [editSeller, setEditSeller] = useState<SellerResponse | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [receiptSeller, setReceiptSeller] = useState<SellerResponse | null>(null);
  const [form, setForm] = useState<SellerForm>(emptyForm);
  const [sortKey, setSortKey] = useState<keyof SellerResponse>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [phoneOtpSent, setPhoneOtpSent] = useState(false);
  const [phoneOtpInput, setPhoneOtpInput] = useState('');
  const [verifyMsg, setVerifyMsg] = useState<{ ok: boolean; msg: string } | null>(null);

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

  const removeBusinessSellerMutation = useMutation({
    mutationFn: (userId: string) => api.skiSwap.removeBusinessSeller(orgId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ski-swap/sellers', orgId] });
      qc.invalidateQueries({ queryKey: ['ski-swap/business-sellers', orgId] });
    },
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
    onSettled: (_, __, sellerId) => {
      qc.setQueryData<SellerResponse[]>(['ski-swap/sellers', orgId], (old) =>
        old?.filter((s) => s.id !== sellerId) ?? [],
      );
      qc.invalidateQueries({ queryKey: ['ski-swap/sellers', orgId] });
      qc.invalidateQueries({ queryKey: ['ski-swap/business-sellers', orgId] });
    },
  });

  const initiateEmailMutation = useMutation({
    mutationFn: (sellerId: string) => api.skiSwap.initiateEmailVerification(orgId, sellerId),
    onSuccess: () => {
      setVerifyMsg({ ok: true, msg: 'Verification email sent — ask the seller to check their inbox.' });
    },
  });

  const initiatePhoneMutation = useMutation({
    mutationFn: (sellerId: string) => api.skiSwap.initiatePhoneVerification(orgId, sellerId),
    onSuccess: () => {
      setPhoneOtpSent(true);
      setVerifyMsg({ ok: true, msg: 'SMS sent — enter the 6-digit code below.' });
    },
  });

  const confirmPhoneMutation = useMutation({
    mutationFn: ({ sellerId, code }: { sellerId: string; code: string }) =>
      api.public.confirmPhoneVerification(sellerId, code),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ski-swap/sellers', orgId] });
      setVerifyMsg({ ok: true, msg: 'Phone verified!' });
      setPhoneOtpInput('');
      setPhoneOtpSent(false);
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

  function closeForm() { setShowForm(false); setEditSeller(null); setForm(emptyForm); setPhoneOtpSent(false); setPhoneOtpInput(''); setVerifyMsg(null); }

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
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) closeForm(); }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (editSeller) patchMutation.mutate(editSeller);
              else if (form.type === 'business') inviteMutation.mutate();
              else createMutation.mutate();
            }}
            className="bg-[#1e1e1e] border border-gray-700 rounded-lg w-full max-w-lg max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 shrink-0">
              <h3 className="text-white font-medium">{editSeller ? 'Edit Seller' : 'New Seller'}</h3>
              <button type="button" onClick={closeForm} className="text-gray-500 hover:text-white text-lg leading-none">✕</button>
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto px-5 py-4 space-y-4 flex-1">
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
                  {/* Contact section */}
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Contact</p>
                    <div className="space-y-2">
                      <label className="block">
                        <span className="text-xs text-gray-400 mb-1 block">Name <span className="text-red-400">*</span></span>
                        <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                          className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className="text-xs text-gray-400 mb-1 block">Phone <span className="text-red-400">*</span></span>
                          <div className="flex gap-1.5">
                            <input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                              className="flex-1 min-w-0 bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
                            {editSeller && !editSeller.phoneVerifiedAt && (
                              <button type="button"
                                disabled={initiatePhoneMutation.isPending}
                                onClick={() => { if (confirm(`Send a verification SMS to ${editSeller.phone}?`)) { setVerifyMsg(null); initiatePhoneMutation.mutate(editSeller.id); } }}
                                className="self-stretch shrink-0 text-xs text-blue-400 border border-blue-800 rounded px-2 hover:bg-blue-900/20 disabled:opacity-40">Verify</button>
                            )}
                          </div>
                        </label>
                        <label className="block">
                          <span className="text-xs text-gray-400 mb-1 block">Email</span>
                          <div className="flex gap-1.5">
                            <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                              className="flex-1 min-w-0 bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
                            {editSeller && form.email && !editSeller.emailVerifiedAt && (
                              <button type="button"
                                disabled={initiateEmailMutation.isPending}
                                onClick={() => { if (confirm(`Send a verification email to ${form.email}?`)) { setVerifyMsg(null); initiateEmailMutation.mutate(editSeller.id); } }}
                                className="self-stretch shrink-0 text-xs text-blue-400 border border-blue-800 rounded px-2 hover:bg-blue-900/20 disabled:opacity-40">Verify</button>
                            )}
                          </div>
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Address section */}
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Address</p>
                    <div className="space-y-2">
                      <label className="block">
                        <span className="text-xs text-gray-400 mb-1 block">Street</span>
                        <input value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })}
                          className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
                      </label>
                      <div className="grid grid-cols-[1fr_80px_80px] gap-2">
                        <label className="block">
                          <span className="text-xs text-gray-400 mb-1 block">City</span>
                          <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })}
                            className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
                        </label>
                        <label className="block">
                          <span className="text-xs text-gray-400 mb-1 block">State</span>
                          <input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })}
                            className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white uppercase" />
                        </label>
                        <label className="block">
                          <span className="text-xs text-gray-400 mb-1 block">ZIP</span>
                          <input value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })}
                            className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Inline OTP entry (shown after phone SMS is sent) */}
                  {phoneOtpSent && editSeller && (
                    <div className="flex gap-2 items-center">
                      <input
                        value={phoneOtpInput}
                        onChange={(e) => setPhoneOtpInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="6-digit code"
                        maxLength={6}
                        className="bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono w-36"
                      />
                      <button
                        type="button"
                        disabled={phoneOtpInput.length !== 6 || confirmPhoneMutation.isPending}
                        onClick={() => confirmPhoneMutation.mutate({ sellerId: editSeller.id, code: phoneOtpInput })}
                        className="text-xs bg-brand-600 hover:bg-brand-700 text-white px-3 py-2 rounded disabled:opacity-40"
                      >
                        {confirmPhoneMutation.isPending ? 'Confirming…' : 'Confirm code'}
                      </button>
                    </div>
                  )}

                  {/* Inline verification feedback */}
                  {verifyMsg && (
                    <p className={`text-xs px-3 py-2 rounded ${verifyMsg.ok ? 'bg-green-900/30 text-green-300' : 'bg-red-900/30 text-red-300'}`}>
                      {verifyMsg.msg}
                    </p>
                  )}

                  <div className="space-y-2 pt-1 border-t border-gray-700">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Payout</p>
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
            </div>

            {/* Footer */}
            {form.type !== '' && (
              <div className="flex gap-2 px-5 py-4 border-t border-gray-700 items-center shrink-0">
                <button type="submit" disabled={createMutation.isPending || patchMutation.isPending || inviteMutation.isPending}
                  className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium disabled:opacity-40">
                  {editSeller ? 'Save' : form.type === 'business' ? 'Send Invite' : 'Create'}
                </button>
                <button type="button" onClick={closeForm}
                  className="text-gray-400 hover:text-white text-sm px-3 py-2">Cancel</button>
{editSeller && editSeller.type !== 'business' && (
                  <button type="button"
                    onClick={() => { if (confirm(`Delete "${editSeller.name}"?`)) { deleteMutation.mutate(editSeller.id); closeForm(); } }}
                    className="text-xs text-red-500 hover:underline ml-auto">Delete</button>
                )}
              </div>
            )}
            {form.type === '' && (
              <div className="px-5 py-4 border-t border-gray-700 shrink-0">
                <button type="button" onClick={closeForm}
                  className="text-gray-400 hover:text-white text-sm px-3 py-1">Cancel</button>
              </div>
            )}
          </form>
        </div>
      )}

      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-400 text-left border-b border-gray-800">
            <SortHeader label="Name"  field="name" />
            <SortHeader label="Email" field="email" />
            <SortHeader label="Phone" field="phone" />
            {canManage && <th className="pb-2">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {sellers.length === 0 && (
            <tr>
              <td colSpan={4} className="py-12 text-center">
                <div className="text-4xl mb-3">🎿</div>
                <p className="text-gray-400 text-sm">No sellers yet — the mountain awaits.</p>
              </td>
            </tr>
          )}
          {sellers.length > 0 && filtered.length === 0 && (
            <tr>
              <td colSpan={4} className="py-12 text-center">
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
              <td className="py-2 pr-4 text-white">{s.name}</td>
              <td className="py-2 pr-4 text-gray-400">
                <span className="flex items-center gap-1.5">
                  <span>{s.email ?? '—'}</span>
                  {s.email && (s.emailVerifiedAt
                    ? <FontAwesomeIcon icon={faCheckCircle} className="text-green-500 w-3 shrink-0" title={`Verified ${new Date(s.emailVerifiedAt).toLocaleDateString()}`} />
                    : <FontAwesomeIcon icon={faCircle} className="text-gray-600 w-2.5 shrink-0" title="Not verified" />
                  )}
                </span>
              </td>
              <td className="py-2 pr-4 text-gray-400 font-mono text-xs">
                <span className="flex items-center gap-1.5">
                  <span>{s.phone}</span>
                  {s.phoneVerifiedAt
                    ? <FontAwesomeIcon icon={faCheckCircle} className="text-green-500 w-3 shrink-0" title={`Verified ${new Date(s.phoneVerifiedAt).toLocaleDateString()}`} />
                    : <FontAwesomeIcon icon={faCircle} className="text-gray-600 w-2.5 shrink-0" title="Not verified" />
                  }
                </span>
              </td>
              {canManage && (
                <td className="py-2">
                  <div className="flex gap-3 items-center">
                    <button onClick={() => openEdit(s)} className="text-xs text-brand-500 hover:underline">Edit</button>
                    <button
                      onClick={() => setReceiptSeller(s)}
                      title="Print receipt"
                      className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
                    >
                      <FontAwesomeIcon icon={faPrint} /> Receipt
                    </button>
                  </div>
                </td>
              )}
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

      {receiptSeller && (
        <PrintReceiptModal seller={receiptSeller} swapId={selectedSwap?.id ?? null} onClose={() => setReceiptSeller(null)} />
      )}

    </div>
  );
}
