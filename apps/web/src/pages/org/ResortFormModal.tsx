import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ResortInput, ResortResponse } from '../../lib/api.types';

/** The zones the server's address lookup can produce, for the manual override. */
const TIME_ZONES = [
  'America/New_York',
  'America/Detroit',
  'America/Indiana/Indianapolis',
  'America/Chicago',
  'America/Denver',
  'America/Boise',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Adak',
  'Pacific/Honolulu',
];

const inputClass =
  'w-full bg-surface-50 border border-gray-700 rounded px-3 py-2 text-white text-sm';

export default function ResortFormModal({
  orgId,
  resort,
  onClose,
  onSaved,
}: {
  orgId: string;
  resort: ResortResponse | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(resort?.name ?? '');
  const [street, setStreet] = useState(resort?.street ?? '');
  const [city, setCity] = useState(resort?.city ?? '');
  const [state, setState] = useState(resort?.state ?? '');
  const [zip, setZip] = useState(resort?.zip ?? '');

  // The zone comes from the address unless someone opens this and picks one.
  const [overriding, setOverriding] = useState(false);
  const [timeZone, setTimeZone] = useState(resort?.timeZone ?? TIME_ZONES[0]);

  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const payload: ResortInput = {
        name: name.trim(),
        street: street.trim() || null,
        city: city.trim() || null,
        state: state.trim().toUpperCase() || null,
        zip: zip.trim() || null,
        ...(overriding ? { timeZone } : {}),
      };
      return resort
        ? api.orgs.patchResort(orgId, resort.id, payload)
        : api.orgs.createResort(orgId, { ...payload, name: name.trim() });
    },
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    save.mutate();
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <form
        onSubmit={handleSubmit}
        className="bg-surface-50 border border-gray-700 rounded-lg p-6 max-w-md w-full space-y-4"
      >
        <h3 className="text-white font-semibold">{resort ? `Edit ${resort.name}` : 'Add resort'}</h3>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <label className="block space-y-1">
          <span className="text-gray-300 text-sm">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            placeholder="North Lodge"
            autoFocus
          />
        </label>

        <label className="block space-y-1">
          <span className="text-gray-300 text-sm">Street</span>
          <input
            value={street}
            onChange={(e) => setStreet(e.target.value)}
            className={inputClass}
            placeholder="1 Summit Road"
          />
        </label>

        <div className="grid grid-cols-6 gap-3">
          <label className="col-span-3 space-y-1">
            <span className="text-gray-300 text-sm">City</span>
            <input value={city} onChange={(e) => setCity(e.target.value)} className={inputClass} />
          </label>
          <label className="col-span-1 space-y-1">
            <span className="text-gray-300 text-sm">State</span>
            <input
              value={state}
              onChange={(e) => setState(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2))}
              className={`${inputClass} uppercase`}
              placeholder="VT"
            />
          </label>
          <label className="col-span-2 space-y-1">
            <span className="text-gray-300 text-sm">ZIP</span>
            <input
              value={zip}
              onChange={(e) => setZip(e.target.value.replace(/[^\d-]/g, '').slice(0, 10))}
              className={inputClass}
              placeholder="05751"
            />
          </label>
        </div>

        {/* Time zone is derived on save; the override is here for the rare ZIP the
            lookup puts on the wrong side of a zone line. */}
        <div className="text-sm space-y-1 border-t border-gray-800 pt-3">
          {overriding ? (
            <label className="block space-y-1">
              <span className="text-gray-300">Time zone</span>
              <select
                value={timeZone}
                onChange={(e) => setTimeZone(e.target.value)}
                className={inputClass}
              >
                {TIME_ZONES.map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setOverriding(false)}
                className="text-gray-400 hover:text-white text-xs"
              >
                Use the address instead
              </button>
            </label>
          ) : (
            <p className="text-gray-500">
              Time zone: {resort ? <span className="text-gray-300">{resort.timeZone}</span> : 'set from the address'}
              {resort && ', re-checked when the address changes'}.{' '}
              <button
                type="button"
                onClick={() => setOverriding(true)}
                className="text-gray-400 hover:text-white underline"
              >
                Set it manually
              </button>
            </p>
          )}
        </div>

        <div className="flex gap-3 justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white text-sm px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || save.isPending}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-1.5 rounded text-sm"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
