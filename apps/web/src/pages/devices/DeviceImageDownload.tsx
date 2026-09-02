import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

/**
 * The image somebody writes to an SD card.
 *
 * Exactly one, never a list. Which version customers get is decided in Platform
 * Admin → Device Software; showing them the catalogue would be showing them
 * versions that were superseded for a reason, and asking them to guess.
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

export default function DeviceImageDownload() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: image, isLoading } = useQuery({
    queryKey: ['device-image-current'],
    queryFn: () => api.deviceImages.current(),
  });

  // Fetched at click time, never held: the URL is short-lived, so one obtained
  // when the page loaded would have expired by the time anybody pressed it.
  async function download() {
    if (!image) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.deviceImages.downloadUrl(image.name, image.version);
      window.location.href = url;
    } catch {
      setError('Could not start the download. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return null;
  // Nothing promoted, or the promoted version has left the catalogue. Silent
  // here on purpose: this is a platform problem, and an error on a customer's
  // device page is something they cannot act on.
  if (!image) return null;

  return (
    <section className="rounded border border-gray-700 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Device image</h3>
          <p className="text-xs text-gray-400 mt-1">
            Write this to an SD card to set up a new device. The same image is used for
            every PatrolKit device; what it becomes is decided when you provision it.
          </p>
          <p className="text-xs text-gray-400 mt-2">
            Version {image.version} · {formatSize(image.sizeBytes)}
          </p>
          {image.notes && <p className="text-xs text-gray-400 mt-0.5">{image.notes}</p>}
          {/* Shown so it can be checked after a 600 MB download over hotel wifi,
              which is exactly where a truncated file comes from. */}
          <p className="text-[11px] text-gray-500 font-mono break-all mt-1">
            sha256 {image.sha256}
          </p>
          {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        </div>
        <button
          type="button"
          onClick={() => void download()}
          disabled={busy}
          className="shrink-0 rounded bg-blue-600 px-3 py-1.5 text-sm hover:bg-blue-500 disabled:opacity-50"
        >
          {busy ? 'Preparing…' : 'Download'}
        </button>
      </div>
    </section>
  );
}
