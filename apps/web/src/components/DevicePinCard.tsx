import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../lib/api';
import type { DevicePinResponse } from '../lib/api.types';

interface Props {
  /** React Query key for this module's PIN, e.g. `['ski-swap/device-pin', orgId]`. */
  queryKey: readonly unknown[];
  get: () => Promise<DevicePinResponse>;
  set: (devicePin: string | null) => Promise<DevicePinResponse>;
  /** What the PIN unlocks, in the plural and in the reader's words: "check-in iPads". */
  deviceLabel: string;
}

/**
 * Sets the PIN that unlocks the settings screen on a module's iPads.
 *
 * One field, not two: the PIN is stored in the clear precisely so an
 * administrator can look it up, so the control that reveals it and the control
 * that changes it are the same box. Masked by default, because the point of a
 * shared PIN is that it stays off a screen someone is presenting from.
 *
 * Shared by both modules. What differs between them is the answer, the route,
 * and what the iPads are called — nothing about the shape of the question.
 */
export default function DevicePinCard({ queryKey, get, set, deviceLabel }: Props) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({ queryKey, queryFn: get });
  const current = data?.devicePin ?? null;

  // The field starts as whatever is stored, so it reads as the PIN rather than
  // as an empty box that might mean "no PIN".
  useEffect(() => setDraft(current ?? ''), [current]);

  const mutation = useMutation({
    mutationFn: (pin: string | null) => set(pin),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => setError(e instanceof ApiError ? e.message : 'Could not save the PIN'),
  });

  const isValid = /^\d{4}$/.test(draft);
  const isDirty = draft !== (current ?? '');

  function save() {
    if (!isValid) {
      setError('The PIN must be exactly 4 digits.');
      return;
    }
    setError(null);
    mutation.mutate(draft);
  }

  function remove() {
    if (!confirm(`Remove the PIN? Anyone will be able to open settings on your ${deviceLabel}.`)) {
      return;
    }
    setError(null);
    mutation.mutate(null);
  }

  return (
    <div className="space-y-3">
      <h2 className="text-white font-semibold">Device PIN</h2>
      <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
        <p className="text-sm text-gray-400">
          Unlocks the settings screen on your {deviceLabel}. Everyone who needs it uses the same
          four digits.
        </p>

        {isLoading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <>
            {!current && (
              <p className="text-sm text-yellow-200 bg-yellow-900/30 border border-yellow-700 rounded px-3 py-2">
                No PIN is set, so anyone can open settings on your {deviceLabel}. Set one below.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <input
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value.replace(/\D/g, '').slice(0, 4));
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && isDirty && isValid) save();
                }}
                type={revealed ? 'text' : 'password'}
                inputMode="numeric"
                autoComplete="off"
                placeholder="••••"
                aria-label="Device PIN"
                className="w-24 bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono tracking-[0.4em] text-center"
              />
              <button
                type="button"
                onClick={() => setRevealed((r) => !r)}
                className="text-sm text-gray-400 hover:text-white px-2 py-2"
              >
                {revealed ? 'Hide' : 'Show'}
              </button>
              <button
                onClick={save}
                disabled={!isDirty || !isValid || mutation.isPending}
                className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm font-medium"
              >
                {mutation.isPending ? 'Saving…' : 'Save PIN'}
              </button>
              {current && (
                <button
                  onClick={remove}
                  disabled={mutation.isPending}
                  className="text-sm text-red-500 hover:underline ml-auto disabled:opacity-40"
                >
                  Remove PIN
                </button>
              )}
            </div>

            {error && <p className="text-red-400 text-sm">{error}</p>}

            {/* The surprise worth heading off: a changed PIN is not instant, and
                an iPad with no signal keeps the old one until it has one. */}
            <p className="text-xs text-gray-500">
              Takes effect the next time each iPad syncs.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
