import { maskDestination } from './public-seller.service';

/**
 * `/s/:sellerId` needs no sign-in, so whatever this returns is as public as the
 * link. The bar is: a seller recognises their own address, and nobody else
 * learns one they could use.
 */
describe('maskDestination', () => {
  it('keeps the first letter and the domain of an email', () => {
    expect(maskDestination('dana@example.com', 'EMAIL')).toBe('d•••@example.com');
  });

  it('never leaks the length of a short local part', () => {
    // Three bullets minimum, so "jo@" and "jonathan@" mask identically at the
    // short end rather than handing over a guess at the address.
    expect(maskDestination('jo@example.com', 'EMAIL')).toBe('j•••@example.com');
    expect(maskDestination('j@example.com', 'EMAIL')).toBe('j•••@example.com');
  });

  it('keeps only the last four digits of a phone', () => {
    expect(maskDestination('+18025551212', 'PHONE')).toBe('(•••) •••-1212');
  });

  it('shows two characters of a typed handle', () => {
    expect(maskDestination('@smoke-venmo', 'VENMO_ID')).toBe('@s••••••••••');
  });

  it('says nothing at all about a check', () => {
    expect(maskDestination(null, null)).toBeNull();
  });

  it('never returns the destination it was given', () => {
    const cases: [string, string][] = [
      ['dana@example.com', 'EMAIL'],
      ['+18025551212', 'PHONE'],
      ['dana-paypal', 'PAYPAL_ID'],
    ];
    for (const [value, type] of cases) {
      expect(maskDestination(value, type)).not.toBe(value);
      expect(maskDestination(value, type)).toContain('•');
    }
  });
});
