import { useEffect, useRef, useState } from 'react';
import { CHECK_EVERY_MS, MIN_GAP_MS, isNewVersion, servedBuildId } from '../lib/newVersion';

/**
 * "A new version of PatrolKit is available": shown when the server has a newer
 * build than this page loaded, so new features aren't missed for want of a
 * refresh. Offers Refresh; never reloads by itself, which could throw away a
 * half-filled form. "Later" hides it until a still newer build appears.
 *
 * A failed load of part of the old build (its files are replaced by a deploy)
 * is the same news, so that shows it too.
 */
export default function NewVersionBanner() {
  const [served, setServed] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const lastCheck = useRef(0);

  useEffect(() => {
    if (__BUILD_ID__ === 'dev') return;
    const check = async (force = false) => {
      if (!force && Date.now() - lastCheck.current < MIN_GAP_MS) return;
      lastCheck.current = Date.now();
      const id = await servedBuildId();
      if (isNewVersion(__BUILD_ID__, id)) setServed(id);
    };
    void check(true);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void check(true); }, CHECK_EVERY_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    const onPreloadError = (e: Event) => { e.preventDefault(); setServed('unknown'); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('vite:preloadError', onPreloadError);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('vite:preloadError', onPreloadError);
    };
  }, []);

  if (!served || served === dismissed) return null;
  return (
    <div role="status" aria-live="polite"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] w-[calc(100%-2rem)] max-w-md flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-brand-700/60 bg-surface-50 shadow-lg px-4 py-3 text-sm">
      <span className="text-gray-100 flex-1 min-w-[12rem]">A new version of PatrolKit is available.</span>
      <button type="button" onClick={() => setDismissed(served)} className="text-gray-400 hover:text-white text-xs">Later</button>
      <button type="button" onClick={() => window.location.reload()}
        className="bg-brand-600 hover:bg-brand-700 text-white px-3 py-1.5 rounded text-sm font-medium">Refresh</button>
    </div>
  );
}
