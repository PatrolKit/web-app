/**
 * The "new version" banner's rules, kept apart so they can be tested.
 *
 * A page keeps running the code it loaded until it's refreshed, so after a
 * deploy it can lack new features (or ask the server for things it no longer
 * answers) without anyone knowing. The page compares its own build id with the
 * one the server now serves (`/version.json`) and offers a refresh.
 */

/** Whether the server serves a different build than this page runs. Never under the dev server. */
export function isNewVersion(current: string, served: string | null | undefined): boolean {
  return current !== 'dev' && !!served && served !== current;
}

/** How often to look while the page stays open and visible. */
export const CHECK_EVERY_MS = 5 * 60_000;
/** A tab coming back into view looks again, but not more often than this. */
export const MIN_GAP_MS = 60_000;

/** The served build id, or null when it can't be read (offline, mid-deploy): never a reason to nag. */
export async function servedBuildId(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher('/version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { buildId?: unknown };
    return typeof body.buildId === 'string' ? body.buildId : null;
  } catch {
    return null;
  }
}
