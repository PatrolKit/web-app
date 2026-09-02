import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

/**
 * The image somebody writes to an SD card.
 *
 * Deliberately not named after the module it appears in. There is one PatrolKit
 * device image and every module gets the same one — a signage screen and an
 * access-control terminal differ by what the server tells them to install, not
 * by what was flashed. Calling it "the signage image" here is how that stops
 * being true.
 */
function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export default function DeviceImageDownload() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: images = [], isLoading } = useQuery({
    queryKey: ['device-images'],
    queryFn: () => api.deviceImages.list(),
  });

  // Fetched at click time, never held: the URL is short-lived, so one obtained
  // when the page loaded would have expired by the time anybody pressed it.
  async function download(name: string, version: string) {
    setBusy(`${name}@${version}`);
    setError(null);
    try {
      const { url } = await api.deviceImages.downloadUrl(name, version);
      window.location.href = url;
    } catch {
      setError('Could not start the download. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  if (isLoading) return null;
  if (images.length === 0) return null;

  return (
    <section className="rounded border border-gray-700 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium">Device image</h3>
        <p className="text-xs text-gray-400 mt-1">
          Write this to an SD card to set up a new device. The same image is used for
          every PatrolKit device; what it becomes is decided when you provision it.
        </p>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <ul className="space-y-2">
        {images.map((img) => (
          <li
            key={`${img.name}@${img.version}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded bg-gray-800/50 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-sm">
                Version {img.version}
                <span className="text-gray-400"> · {formatSize(img.sizeBytes)}</span>
                <span className="text-gray-400"> · {formatDate(img.builtAt)}</span>
              </p>
              {img.notes && <p className="text-xs text-gray-400 mt-0.5">{img.notes}</p>}
              {/* Shown so it can be checked after a 600 MB download over hotel
                  wifi, which is exactly where a truncated file comes from. */}
              <p className="text-[11px] text-gray-500 font-mono break-all mt-1">
                sha256 {img.sha256}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void download(img.name, img.version)}
              disabled={busy === `${img.name}@${img.version}`}
              className="shrink-0 rounded bg-blue-600 px-3 py-1.5 text-sm hover:bg-blue-500 disabled:opacity-50"
            >
              {busy === `${img.name}@${img.version}` ? 'Preparing…' : 'Download'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
