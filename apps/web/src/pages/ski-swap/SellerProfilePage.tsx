import { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { SellerResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';

interface ProfileFormData {
  name: string; phone: string; email: string;
  street: string; city: string; state: string; zip: string;
}

export default function SellerProfilePage() {
  const { orgId } = useOutletContext<SkiSwapContext>();
  const qc = useQueryClient();

  const { data: profile } = useQuery<SellerResponse>({
    queryKey: ['seller/profile', orgId],
    queryFn: () => api.skiSwap.sellerGetProfile(orgId),
    enabled: !!orgId,
  });

  const [form, setForm] = useState<ProfileFormData>({ name: '', phone: '', email: '', street: '', city: '', state: '', zip: '' });
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (profile) {
      setForm({
        name: profile.name,
        phone: profile.phone,
        email: profile.email ?? '',
        street: profile.street ?? '',
        city: profile.city ?? '',
        state: profile.state ?? '',
        zip: profile.zip ?? '',
      });
    }
  }, [profile]);

  const saveMutation = useMutation({
    mutationFn: () => api.skiSwap.sellerUpdateProfile(orgId, {
      ...form,
      email: form.email || null,
      street: form.street || null,
      city: form.city || null,
      state: form.state || null,
      zip: form.zip || null,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['seller/profile', orgId] }); setEditing(false); },
  });

  return (
    <div className="space-y-4 max-w-md">
      {(['name', 'phone', 'email', 'street', 'city', 'state', 'zip'] as const).map((field) => (
        <div key={field}>
          <label className="block text-xs text-gray-400 mb-1 capitalize">{field}</label>
          {editing ? (
            <input
              className="w-full bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white"
              value={form[field]}
              onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
            />
          ) : (
            <p className="text-sm text-white">{form[field] || <span className="text-gray-500">—</span>}</p>
          )}
        </div>
      ))}

      {editing ? (
        <div className="flex gap-2 pt-2">
          <button
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded disabled:opacity-40"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >Save</button>
          <button className="px-4 py-1.5 bg-surface-100 text-gray-300 text-sm rounded" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      ) : (
        <button className="px-4 py-1.5 bg-surface-100 hover:bg-surface-200 text-white text-sm rounded" onClick={() => setEditing(true)}>Edit Profile</button>
      )}
    </div>
  );
}
