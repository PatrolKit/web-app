import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { MutationError } from '../devices/DeviceCredentials';
import { DEVICE_ROLES } from '../../lib/api.types';
import type {
  BootstrapProfileItem,
  BootstrapRepositoryItem,
  BootstrapRepositoryInput,
} from '../../lib/api.types';

const input =
  'w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm';
const label = 'block text-xs text-gray-400 mb-1';

const EMPTY_REPO: BootstrapRepositoryInput = {
  name: '',
  uri: 'https://apt.patrolkit.io',
  suite: 'trixie',
  components: ['main'],
  arch: 'arm64',
  signedByKeyId: '',
  pinPriority: null,
};

/**
 * What every PatrolKit device runs.
 *
 * This is the page that makes the device image generic in practice rather than
 * in principle: it is where "this device is a signage device, here is the
 * package and version to run" is expressed, replacing a choice that used to be
 * baked into an image at build time. One answer per role, platform-wide.
 */
export default function DeviceSoftwareTab() {
  const { data: repositories = [], isLoading: reposLoading } = useQuery({
    queryKey: ['bootstrap-repositories'],
    queryFn: () => api.bootstrap.listRepositories(),
  });
  const { data: profiles = [], isLoading: profilesLoading } = useQuery({
    queryKey: ['bootstrap-profiles'],
    queryFn: () => api.bootstrap.listProfiles(),
  });

  if (reposLoading || profilesLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="space-y-8">
      <DeviceImages />
      <Repositories repositories={repositories} />
      <Profiles repositories={repositories} profiles={profiles} />
    </div>
  );
}

// ─── Device images ───────────────────────────────────────────────────────────

/**
 * Which image customers are offered.
 *
 * The bucket keeps every image ever published, because an older one is
 * occasionally the one somebody needs. Customers see exactly one — the promoted
 * version — so choosing it is a decision made here rather than a guess made by
 * whoever is standing at a lift shack with an SD card.
 */
function DeviceImages() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const { data: images = [], isLoading } = useQuery({
    queryKey: ['admin-device-images'],
    queryFn: () => api.deviceImagesAdmin.list(),
  });

  const promote = useMutation({
    mutationFn: ({ name, version }: { name: string; version: string }) =>
      api.deviceImagesAdmin.promote(name, version),
    onSuccess: () => {
      setError(null);
      // Both views: this changes what every customer is offered.
      void qc.invalidateQueries({ queryKey: ['admin-device-images'] });
      void qc.invalidateQueries({ queryKey: ['device-image-current'] });
    },
    onError: () => setError('Could not change the released image.'),
  });

  // Administrators can download any build, promoted or not, to check it before
  // customers are offered it.
  async function download(name: string, version: string) {
    setBusy(`${name}@${version}`);
    try {
      const { url } = await api.deviceImagesAdmin.downloadUrl(name, version);
      window.location.href = url;
    } catch {
      setError('Could not start the download.');
    } finally {
      setBusy(null);
    }
  }

  if (isLoading) return <p className="text-gray-400">Loading images…</p>;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-white font-medium">Device image</h2>
        <p className="text-xs text-gray-400 mt-1">
          The image customers download to set up a device. Exactly one is released at a
          time; publishing a new build does not release it until you say so.
        </p>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {images.length === 0 ? (
        <p className="text-sm text-gray-400">
          No images have been published yet.
        </p>
      ) : (
        <>
          {!images.some((i) => i.promoted) && (
            // Worth saying plainly: until something is released, the download
            // section simply does not appear for customers.
            <p className="text-xs text-amber-400">
              Nothing is released. Customers are not offered a download.
            </p>
          )}
          <ul className="space-y-2">
            {images.map((img) => (
              <li
                key={`${img.name}@${img.version}`}
                className={`flex flex-wrap items-center justify-between gap-3 rounded px-3 py-2 ${
                  img.promoted ? 'bg-blue-900/30 border border-blue-700' : 'bg-gray-800/50'
                }`}
              >
                <div className="min-w-0">
                  <p className="text-sm">
                    {img.name} {img.version}
                    {img.promoted && (
                      <span className="ml-2 rounded bg-blue-600 px-1.5 py-0.5 text-[11px]">
                        Released
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {(img.sizeBytes / 1024 / 1024).toFixed(0)} MB ·{' '}
                    {new Date(img.builtAt).toLocaleDateString()}
                    {img.gitSha && ` · ${img.gitSha}`}
                  </p>
                  {img.notes && <p className="text-xs text-gray-400 mt-0.5">{img.notes}</p>}
                  <p className="text-[11px] text-gray-500 font-mono break-all mt-1">
                    sha256 {img.sha256}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void download(img.name, img.version)}
                    disabled={busy === `${img.name}@${img.version}`}
                    className="rounded border border-gray-600 px-2 py-1 text-xs hover:bg-gray-700 disabled:opacity-50"
                  >
                    {busy === `${img.name}@${img.version}` ? 'Preparing…' : 'Download'}
                  </button>
                  <button
                    type="button"
                    onClick={() => promote.mutate({ name: img.name, version: img.version })}
                    disabled={img.promoted || promote.isPending}
                    className="rounded bg-blue-600 px-2 py-1 text-xs hover:bg-blue-500 disabled:opacity-40"
                  >
                    {img.promoted ? 'Released' : 'Release'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ─── Repositories ────────────────────────────────────────────────────────────

function Repositories({ repositories }: { repositories: BootstrapRepositoryItem[] }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<BootstrapRepositoryItem | 'new' | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.bootstrap.deleteRepository(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bootstrap-repositories'] }),
  });

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-white font-medium">Repositories</h2>
        <p className="text-xs text-gray-500 max-w-3xl">
          Where devices install from. Named in every manifest, so an edit here reaches every
          role that uses it.
        </p>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => setEditing('new')}
          className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium"
        >
          + Add repository
        </button>
      </div>

      <MutationError error={remove.error} />

      <div className="space-y-2">
        {repositories.map((repo) => (
          <div
            key={repo.id}
            className="bg-surface-50 border border-gray-700 rounded-lg p-4 flex items-start justify-between gap-4"
          >
            <div className="min-w-0">
              <p className="text-white font-medium">{repo.name}</p>
              <p className="text-xs text-gray-400 font-mono truncate">
                {repo.uri} · {repo.suite} · {repo.components.join(', ')} · {repo.arch}
              </p>
              <p className="text-xs text-gray-500 font-mono truncate">{repo.signedByKeyId}</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setEditing(repo)} className="text-xs text-yellow-500 hover:underline">
                Edit
              </button>
              <button
                onClick={() => {
                  if (window.confirm(`Remove "${repo.name}"? Any role still naming it must be changed first.`)) {
                    remove.mutate(repo.id);
                  }
                }}
                className="text-xs text-red-500 hover:underline"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {repositories.length === 0 && (
          <p className="text-gray-500 text-sm">No repositories yet — devices have nowhere to install from.</p>
        )}
      </div>

      {editing && (
        <RepositoryForm
          existing={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function RepositoryForm({
  existing,
  onDone,
}: {
  existing: BootstrapRepositoryItem | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<BootstrapRepositoryInput>(
    existing
      ? {
          name: existing.name,
          uri: existing.uri,
          suite: existing.suite,
          components: existing.components,
          arch: existing.arch,
          signedByKeyId: existing.signedByKeyId,
          pinPriority: existing.pinPriority,
        }
      : EMPTY_REPO,
  );

  const save = useMutation({
    mutationFn: () =>
      existing
        ? api.bootstrap.updateRepository(existing.id, form)
        : api.bootstrap.createRepository(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bootstrap-repositories'] });
      qc.invalidateQueries({ queryKey: ['bootstrap-profiles'] });
      onDone();
    },
  });

  const set = <K extends keyof BootstrapRepositoryInput>(key: K, value: BootstrapRepositoryInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
      className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3"
    >
      <h3 className="text-white font-medium">{existing ? `Edit ${existing.name}` : 'New repository'}</h3>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className={label}>Name</span>
          <input
            value={form.name}
            onChange={(e) => set('name', e.target.value.toLowerCase())}
            pattern="[a-z0-9][a-z0-9-]*"
            required
            className={`${input} font-mono`}
          />
          <span className="block text-xs text-gray-500 mt-1">The apt source name.</span>
        </label>
        <label className="block">
          <span className={label}>URI</span>
          <input
            value={form.uri}
            onChange={(e) => set('uri', e.target.value)}
            type="url"
            required
            className={`${input} font-mono`}
          />
          <span className="block text-xs text-gray-500 mt-1">https only — devices refuse anything else.</span>
        </label>
        <label className="block">
          <span className={label}>Suite</span>
          <input value={form.suite} onChange={(e) => set('suite', e.target.value)} required className={`${input} font-mono`} />
        </label>
        <label className="block">
          <span className={label}>Components</span>
          <input
            value={form.components.join(', ')}
            onChange={(e) => set('components', e.target.value.split(',').map((c) => c.trim()).filter(Boolean))}
            required
            className={`${input} font-mono`}
          />
        </label>
        <label className="block">
          <span className={label}>Architecture</span>
          <select value={form.arch} onChange={(e) => set('arch', e.target.value as 'arm64' | 'armhf')} className={input}>
            <option value="arm64">arm64</option>
            <option value="armhf">armhf</option>
          </select>
        </label>
        <label className="block">
          <span className={label}>Pin priority (optional)</span>
          <input
            value={form.pinPriority ?? ''}
            onChange={(e) => set('pinPriority', e.target.value === '' ? null : Number(e.target.value))}
            type="number"
            className={input}
          />
        </label>
      </div>

      <label className="block">
        <span className={label}>Signing key fingerprint</span>
        <input
          value={form.signedByKeyId}
          onChange={(e) => set('signedByKeyId', e.target.value)}
          required
          className={`${input} font-mono`}
          placeholder="A267DE35610137808C467188B7B81B42B960F4F0"
        />
      </label>

      {/* Not a tooltip. This is the one field on the page that fails silently,
          on every device at once, with no error path back here. */}
      <div className="bg-amber-950/40 border border-amber-900 rounded px-3 py-2 text-xs text-amber-200 space-y-1">
        <p className="font-medium">This server cannot check that fingerprint.</p>
        <p className="text-amber-300/80">
          Every signing key a device will ever trust is baked into its image at build time. A
          manifest naming any other key is rejected outright, on the device, with nothing
          reported back here — so a typo takes every device using this repository out of service
          until someone notices they have stopped updating. Copy it from the image&apos;s{' '}
          <span className="font-mono">keys/</span> directory rather than typing it.
        </p>
      </div>

      <MutationError error={save.error} />

      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onDone} className="text-sm text-gray-400 hover:text-white px-3 py-2">
          Cancel
        </button>
        <button
          type="submit"
          disabled={save.isPending}
          className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

// ─── Profiles ────────────────────────────────────────────────────────────────

function Profiles({
  repositories,
  profiles,
}: {
  repositories: BootstrapRepositoryItem[];
  profiles: BootstrapProfileItem[];
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-white font-medium">What each device role runs</h2>
        <p className="text-xs text-gray-500 max-w-3xl">
          One answer per role, for every organisation. A device asks on a schedule and installs
          what it is told inside its update window, so a change here reaches the whole fleet
          without anyone touching a device.
        </p>
      </div>

      {DEVICE_ROLES.map((role) => (
        <ProfileCard
          key={role.value}
          role={role.value}
          roleLabel={role.label}
          repositories={repositories}
          profile={profiles.find((p) => p.role === role.value) ?? null}
        />
      ))}
    </section>
  );
}

interface Draft {
  deviceType: string;
  enabled: boolean;
  updateEnabled: boolean;
  updateWindow: string;
  checkinIntervalSec: number;
  repositoryIds: string[];
  packages: { name: string; version: string | null }[];
}

function draftFrom(profile: BootstrapProfileItem | null, repositories: BootstrapRepositoryItem[]): Draft {
  if (profile) {
    return {
      deviceType: profile.deviceType,
      enabled: profile.enabled,
      updateEnabled: profile.updateEnabled,
      updateWindow: profile.updateWindow ?? '',
      checkinIntervalSec: profile.checkinIntervalSec,
      repositoryIds: profile.repositories.map((r) => r.id),
      packages: profile.packages.map((p) => ({ name: p.name, version: p.version })),
    };
  }
  return {
    deviceType: '',
    enabled: true,
    updateEnabled: true,
    updateWindow: '03:00-05:00',
    checkinIntervalSec: 3600,
    repositoryIds: repositories.slice(0, 1).map((r) => r.id),
    packages: [],
  };
}

function ProfileCard({
  role,
  roleLabel,
  repositories,
  profile,
}: {
  role: string;
  roleLabel: string;
  repositories: BootstrapRepositoryItem[];
  profile: BootstrapProfileItem | null;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(profile, repositories));

  // A save refetches the list, and the freshly-resolved versions on it are
  // exactly what someone wants to see afterwards.
  useEffect(() => setDraft(draftFrom(profile, repositories)), [profile, repositories]);

  const save = useMutation({
    mutationFn: () =>
      api.bootstrap.upsertProfile(role, {
        deviceType: draft.deviceType,
        enabled: draft.enabled,
        updateEnabled: draft.updateEnabled,
        updateWindow: draft.updateWindow || null,
        checkinIntervalSec: draft.checkinIntervalSec,
        repositoryIds: draft.repositoryIds,
        packages: draft.packages,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bootstrap-profiles'] });
      qc.invalidateQueries({ queryKey: ['bootstrap-preview', role] });
    },
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-white font-medium">
            {roleLabel} <span className="text-xs text-gray-500 font-mono">{role}</span>
          </p>
          {profile ? (
            <p className="text-xs text-gray-400">
              {profile.packages.map((p) => `${p.name} ${p.version ?? `latest (${p.resolvedVersion ?? 'unresolved'})`}`).join(', ')}
              {' · '}
              {profile.enabled ? 'serving' : 'switched off'}
              {' · edit '}
              {profile.manifestVersion}
            </p>
          ) : (
            /* Not an error. Most roles are not image-based and never will be —
               a print bridge runs firmware, not packages. */
            <p className="text-xs text-gray-500">
              Nothing configured. Devices of this role are told nothing, and keep whatever they
              already have.
            </p>
          )}
        </div>
        <button onClick={() => setOpen((o) => !o)} className="text-xs text-yellow-500 hover:underline shrink-0">
          {open ? 'Close' : profile ? 'Edit' : 'Configure'}
        </button>
      </div>

      {open && (
        <form
          onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
          className="space-y-3 border-t border-gray-800 pt-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={label}>Device type</span>
              <input
                value={draft.deviceType}
                onChange={(e) => set('deviceType', e.target.value)}
                required
                placeholder="patrolkit-signage"
                className={`${input} font-mono`}
              />
              <span className="block text-xs text-gray-500 mt-1">
                Passed through to the device, which never branches on it.
              </span>
            </label>
            <label className="block">
              <span className={label}>Check-in interval (seconds)</span>
              <input
                value={draft.checkinIntervalSec}
                onChange={(e) => set('checkinIntervalSec', Number(e.target.value))}
                type="number"
                min={60}
                max={86400}
                required
                className={input}
              />
            </label>
            <label className="block">
              <span className={label}>Update window</span>
              <input
                value={draft.updateWindow}
                onChange={(e) => set('updateWindow', e.target.value)}
                placeholder="03:00-05:00"
                pattern="([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]"
                className={`${input} font-mono`}
              />
              <span className="block text-xs text-gray-500 mt-1">
                Device local time. Blank leaves the image&apos;s own window in force.
              </span>
            </label>
            <div className="space-y-2 pt-5">
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
                Serve this manifest
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={draft.updateEnabled} onChange={(e) => set('updateEnabled', e.target.checked)} />
                Allow upgrades
              </label>
            </div>
          </div>

          <div>
            <span className={label}>Repositories</span>
            <div className="space-y-1">
              {repositories.map((repo) => (
                <label key={repo.id} className="flex items-center gap-2 text-sm text-gray-300">
                  <input
                    type="checkbox"
                    checked={draft.repositoryIds.includes(repo.id)}
                    onChange={(e) =>
                      set(
                        'repositoryIds',
                        e.target.checked
                          ? [...draft.repositoryIds, repo.id]
                          : draft.repositoryIds.filter((id) => id !== repo.id),
                      )
                    }
                  />
                  <span className="font-mono text-xs">{repo.name}</span>
                  <span className="text-xs text-gray-500">{repo.uri}</span>
                </label>
              ))}
            </div>
          </div>

          <Packages
            packages={draft.packages}
            resolved={profile?.packages ?? []}
            onChange={(packages) => set('packages', packages)}
          />

          <MutationError error={save.error} />

          <div className="flex items-center justify-between">
            <Preview role={role} />
            <button
              type="submit"
              disabled={save.isPending || draft.packages.length === 0 || draft.repositoryIds.length === 0}
              className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Packages({
  packages,
  resolved,
  onChange,
}: {
  packages: { name: string; version: string | null }[];
  resolved: BootstrapProfileItem['packages'];
  onChange: (packages: { name: string; version: string | null }[]) => void;
}) {
  return (
    <div className="space-y-2">
      <span className={label}>Packages</span>
      {packages.map((pkg, i) => {
        const known = resolved.find((r) => r.name === pkg.name);
        return (
          <div key={i} className="flex items-start gap-2">
            <input
              value={pkg.name}
              onChange={(e) =>
                onChange(packages.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))
              }
              placeholder="patrolkit-signage"
              required
              className={`${input} font-mono flex-1`}
            />
            <div className="flex-1">
              <input
                value={pkg.version ?? ''}
                onChange={(e) =>
                  onChange(
                    packages.map((p, j) => (j === i ? { ...p, version: e.target.value || null } : p)),
                  )
                }
                placeholder="leave blank to track the newest"
                className={`${input} font-mono`}
              />
              {pkg.version === null && (
                <p className="text-xs text-amber-400/80 mt-1">
                  Tracking:{' '}
                  {known?.resolvedVersion
                    ? `${known.resolvedVersion}${known.resolvedAt ? ` (checked ${new Date(known.resolvedAt).toLocaleString()})` : ''}`
                    : 'not resolved yet'}
                  {' — publishing a new build deploys it.'}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onChange(packages.filter((_, j) => j !== i))}
              className="text-xs text-red-500 hover:underline pt-2.5"
            >
              Remove
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...packages, { name: '', version: null }])}
        className="text-xs text-brand-400 hover:underline"
      >
        + Add package
      </button>
    </div>
  );
}

/**
 * Exactly what a device would be served, and under what ETag.
 *
 * The only way to be sure before a fleet acts on it — and the only place a
 * failure to resolve a tracked package is visible, since to a device that is a
 * 503 and a retry.
 */
function Preview({ role }: { role: string }) {
  const [show, setShow] = useState(false);
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['bootstrap-preview', role],
    queryFn: () => api.bootstrap.preview(role),
    enabled: show,
  });

  if (!show) {
    return (
      <button type="button" onClick={() => setShow(true)} className="text-xs text-brand-400 hover:underline">
        Preview what a device gets
      </button>
    );
  }

  return (
    <div className="w-full space-y-2">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => refetch()} className="text-xs text-brand-400 hover:underline">
          {isFetching ? 'Resolving…' : 'Refresh preview'}
        </button>
        <button type="button" onClick={() => setShow(false)} className="text-xs text-gray-500 hover:underline">
          Hide
        </button>
        {data?.etag && <span className="text-xs text-gray-500 font-mono">ETag {data.etag}</span>}
      </div>
      {data?.error && (
        <p className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-2 py-1.5">
          {data.error}
        </p>
      )}
      {data?.manifest && (
        <pre className="text-xs text-gray-300 bg-surface-100 border border-gray-800 rounded p-3 overflow-x-auto">
          {JSON.stringify(data.manifest, null, 2)}
        </pre>
      )}
    </div>
  );
}
