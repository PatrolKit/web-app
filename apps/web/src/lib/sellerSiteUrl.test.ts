import { describe, expect, it } from 'vitest';
import { staffSiteUrl } from './sellerSiteUrl';

const at = (url: string) => {
  const u = new URL(url);
  return { protocol: u.protocol, host: u.host, pathname: u.pathname, search: u.search, hash: u.hash };
};

describe('a staff page asked of the seller site', () => {
  it('goes to the same address on the staff site', () => {
    expect(staffSiteUrl(at('https://skiswap.patrolkit.io/app/auth/login'))).toBe('https://patrolkit.io/app/auth/login');
    expect(staffSiteUrl(at('https://skiswap.patrolkit.io/app/dashboard/ski-swap/items?status=needs_price#x')))
      .toBe('https://patrolkit.io/app/dashboard/ski-swap/items?status=needs_price#x');
  });

  it('keeps a port, and leaves a host without the prefix alone', () => {
    expect(staffSiteUrl(at('http://skiswap.localhost:3000/app/'))).toBe('http://localhost:3000/app/');
    expect(staffSiteUrl(at('https://patrolkit.io/app/'))).toBe('https://patrolkit.io/app/');
  });
});
