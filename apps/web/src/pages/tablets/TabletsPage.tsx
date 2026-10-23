import { useCallback, useState } from 'react';
import { Navigate, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  faCircleCheck as faCircleCheckDuo,
  faCircleQuestion as faCircleQuestionDuo,
  faPlugCircleXmark as faPlugCircleXmarkDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api } from '../../lib/api';
import { tabletModeLabel } from '../../lib/api.types';
import type { DeviceItem } from '../../lib/api.types';
import DevicePinCard from '../../components/DevicePinCard';
import { MutationError, PairingCodePopover } from '../devices/DeviceCredentials';
import { lastSeenTitle, OFFLINE_AFTER_TABLET_MS, recentlySeen, StatusLine, useClockTick } from '../devices/hardwareStatus';
import type { HardwareStatus } from '../devices/hardwareStatus';
import { timeAgo } from '../../lib/timeAgo';

const TABLET_ROLE = 'org.tablet' as const;

/** An iPad still on a module's own role, until it runs a build that knows tablets (Plan 56 D11). */
const LEGACY_ROLE_NOTE: Record<string, string> = {
  'ski_swap.staff_check_in': 'Ski Swap only until it’s converted to a tablet',
  'time_clock.terminal': 'Time Clock only until it’s converted to a tablet',
};

const inputClass = 'bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm';
const actionClass = 'text-xs px-2 py-1 bg-surface-100 hover:bg-surface-200 text-gray-300 rounded disabled:opacity-40';

/**
 * The org's iPads (Plan 56).
 *
 * One set of iPads runs Ski Swap once a year and Time Clock the rest of it, so
 * they belong to neither module: org administrators add them here, see how each
 * is doing, and set the PIN that guards them. Which module an iPad runs is
 * chosen on the iPad. Which station it serves is chosen on Ski Swap → Check-in,
 * and which resort it stands at, on the iPad in Time Clock mode.
 */
export default function TabletsPage() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [pairing, setPairing] = useState<{ id: string; clientId: string; secret: string; issuedAt: string | null; name: string } | null>(null);
  useClockTick();

  const { data: tablets = [], isLoading } = useQuery({
    queryKey: ['tablets', orgId],
    queryFn: () => api.tablets.list(orgId),
    enabled: !!orgId && perms.has('org:manage'),
    // Status is judged against the clock, so the list has to keep moving.
    refetchInterval: 10_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['tablets', orgId] });

  const provision = useMutation({
    mutationFn: (name: string) => api.devices.provision(orgId, { name, role: TABLET_ROLE }),
    onSuccess: (d) => {
      setAdding(false);
      setNewName('');
      void refresh();
      setPairing({ id: d.id, clientId: d.clientId, secret: d.clientSecret, issuedAt: d.createdAt, name: d.name });
    },
  });

  const newCode = useMutation({
    mutationFn: async (t: DeviceItem) => ({ t, ...(await api.devices.rotateSecret(orgId, t.id)) }),
    onSuccess: ({ t, clientSecret, rotatedAt }) => {
      void refresh();
      setPairing({ id: t.id, clientId: t.clientId, secret: clientSecret, issuedAt: rotatedAt, name: t.name });
    },
  });

  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.devices.rename(orgId, v.id, v.name),
    onSuccess: () => {
      void refresh();
      void qc.invalidateQueries({ queryKey: ['ski-swap/stations', orgId] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.devices.revoke(orgId, id),
    onSettled: () => {
      void refresh();
      void qc.invalidateQueries({ queryKey: ['ski-swap/stations', orgId] });
    },
  });

  const closePairing = useCallback(() => setPairing(null), []);

  if (!perms.has('org:manage')) return <Navigate to="/dashboard" replace />;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Tablets</h1>
        <p className="text-sm text-gray-400 mt-1 max-w-2xl">
          The organization’s iPads. Each runs Ski Swap or Time Clock, chosen on the iPad behind the PIN below.
          Put one at a check-in station on Ski Swap → Check-in; a Time Clock iPad picks its resort itself.
        </p>
      </div>

      <section className="max-w-lg">
        <DevicePinCard
          queryKey={['tablets/pin', orgId]}
          get={() => api.tablets.getPin(orgId)}
          set={(pin) => api.tablets.setPin(orgId, pin)}
          deviceLabel="tablets"
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-white font-semibold">iPads</h2>
            <p className="text-xs text-gray-500">Name each one as it’s labelled on its case, so it can be found.</p>
          </div>
          <button
            onClick={() => { setAdding(true); provision.reset(); }}
            className="shrink-0 bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium"
          >
            + Add tablet
          </button>
        </div>

        {adding && (
          <form
            onSubmit={(e) => { e.preventDefault(); if (newName.trim()) provision.mutate(newName.trim()); }}
            className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3 max-w-lg"
          >
            <h3 className="text-white font-medium">New tablet</h3>
            <label className="block">
              <span className="block text-xs text-gray-400 mb-1">Name</span>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. iPad 4"
                maxLength={100}
                className={`${inputClass} w-full`}
              />
            </label>
            <p className="text-xs text-gray-500">A pairing code opens next. Scan it with PatrolKit on the iPad.</p>
            <MutationError error={provision.error} />
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setAdding(false)} className="text-sm text-gray-400 hover:text-white px-3 py-2">Cancel</button>
              <button
                type="submit"
                disabled={!newName.trim() || provision.isPending}
                className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
              >
                {provision.isPending ? 'Adding…' : 'Add tablet'}
              </button>
            </div>
          </form>
        )}

        <MutationError error={newCode.error ?? rename.error ?? remove.error} />

        {isLoading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : tablets.length === 0 ? (
          <p className="text-sm text-gray-500">No tablets yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  {['Tablet', 'Mode', 'Serves', 'Status', 'App', ''].map((c, i) => (
                    <th key={i} className="font-normal py-2 pr-4 whitespace-nowrap">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tablets.map((t) => (
                  <TabletRow
                    key={t.id}
                    tablet={t}
                    busy={newCode.isPending || rename.isPending || remove.isPending}
                    onRename={(name) => rename.mutate({ id: t.id, name })}
                    onNewCode={() => newCode.mutate(t)}
                    onRemove={() => {
                      const where = t.stationName ? ` It leaves ${t.stationName} waiting for another tablet.` : '';
                      if (window.confirm(`Remove ${t.name}? It stops working at once and has to be added again from scratch.${where}`)) {
                        remove.mutate(t.id);
                      }
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {pairing && (
        <PairingCodePopover
          orgId={orgId}
          deviceId={pairing.id}
          clientId={pairing.clientId}
          secret={pairing.secret}
          issuedAt={pairing.issuedAt}
          deviceName={pairing.name}
          onClose={closePairing}
        />
      )}
    </div>
  );
}

function TabletRow({
  tablet,
  busy,
  onRename,
  onNewCode,
  onRemove,
}: {
  tablet: DeviceItem;
  busy: boolean;
  onRename: (name: string) => void;
  onNewCode: () => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tablet.name);
  const mode = tabletModeLabel(tablet.appMode);
  const app = appText(tablet);
  const serves = [tablet.stationName, tablet.resortName].filter(Boolean) as string[];

  function save() {
    const name = draft.trim();
    if (name && name !== tablet.name) onRename(name);
    setEditing(false);
  }

  return (
    <tr id={`tablet-${tablet.id}`} className="border-b border-gray-800/60 target:bg-brand-900/20">
      <td className="py-3 pr-4 align-top">
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); save(); }} className="flex gap-2">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(tablet.name); setEditing(false); } }}
              maxLength={100}
              aria-label="Tablet name"
              className={`${inputClass} py-1 w-40`}
            />
            <button type="submit" className="text-xs text-brand-500 hover:underline">Save</button>
          </form>
        ) : (
          <button
            onClick={() => { setDraft(tablet.name); setEditing(true); }}
            className="text-white font-medium hover:underline text-left"
            title="Rename"
          >
            {tablet.name}
          </button>
        )}
        {LEGACY_ROLE_NOTE[tablet.role] && (
          <span className="block text-xs text-gray-500">{LEGACY_ROLE_NOTE[tablet.role]}</span>
        )}
      </td>
      <td className="py-3 pr-4 align-top whitespace-nowrap">
        {mode ? <span className="text-gray-200">{mode}</span> : <span className="text-gray-600" title="It reports its mode once it runs an app that does">Not reported</span>}
      </td>
      <td className="py-3 pr-4 align-top">
        {serves.length ? (
          <span className="text-gray-200">{serves.join(' · ')}</span>
        ) : (
          <span className="text-gray-600">Nothing yet</span>
        )}
      </td>
      <td className="py-3 pr-4 align-top whitespace-nowrap">
        <StatusLine status={statusOf(tablet)} />
        {tablet.lastSeenAt && (
          <span className="block text-xs text-gray-500" title={new Date(tablet.lastSeenAt).toLocaleString()}>
            Seen {timeAgo(tablet.lastSeenAt)}
          </span>
        )}
      </td>
      <td className="py-3 pr-4 align-top whitespace-nowrap text-xs text-gray-400">
        {app ?? <span className="text-gray-600">—</span>}
      </td>
      <td className="py-3 align-top text-right whitespace-nowrap space-x-1">
        <button
          className={actionClass}
          disabled={busy}
          onClick={onNewCode}
          title="Issues a new pairing code and locks out the old one: for an iPad that was wiped, reinstalled, lost or swapped"
        >
          New code
        </button>
        <button
          className="text-xs px-2 py-1 bg-surface-100 hover:bg-red-900/40 text-gray-400 hover:text-red-300 rounded disabled:opacity-40"
          disabled={busy}
          onClick={onRemove}
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

function appText(t: DeviceItem): string | null {
  if (t.appVersion && t.appBuild) return `${t.appVersion} (${t.appBuild})`;
  return t.appVersion ?? (t.appBuild ? `Build ${t.appBuild}` : null);
}

/** Online, offline, or never set up: the same rule the station rows use for their iPad. */
function statusOf(t: DeviceItem): HardwareStatus {
  if (!t.lastTokenAt && !t.lastSeenAt) {
    return { icon: faCircleQuestionDuo, label: 'Not set up', tone: 'unknown', title: 'Its pairing code hasn’t been used. Issue a new code to pair it.' };
  }
  if (!recentlySeen(t.lastSeenAt, OFFLINE_AFTER_TABLET_MS)) {
    return { icon: faPlugCircleXmarkDuo, label: 'Offline', tone: 'bad', title: lastSeenTitle(t.lastSeenAt) };
  }
  return { icon: faCircleCheckDuo, label: 'Online', tone: 'ok', title: lastSeenTitle(t.lastSeenAt) };
}
