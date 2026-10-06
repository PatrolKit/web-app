export const SELLER_SITE_URL =
  import.meta.env.VITE_SELLER_SITE_URL ?? 'http://localhost:3000';

/**
 * The same address on the staff site, for a page the seller site doesn't
 * have. `skiswap.patrolkit.io` serves only the public seller pages, so its
 * home page's Log in (`/app/auth/login`) and any dashboard link belong on
 * `patrolkit.io`.
 */
export function staffSiteUrl(loc: Pick<Location, 'protocol' | 'host' | 'pathname' | 'search' | 'hash'>): string {
  return `${loc.protocol}//${loc.host.replace(/^skiswap\./, '')}${loc.pathname}${loc.search}${loc.hash}`;
}
