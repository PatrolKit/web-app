import { BadRequestException } from '@nestjs/common';
import { assertPayoutIsCoherent } from './seller.service';

/**
 * The combinations a payout may be in — one case per row of the plan's table,
 * plus the ones it says are refused.
 *
 * These are invariants, not completeness: nothing here requires a seller to
 * have answered, only that what is recorded makes sense. Whether they answered
 * is checked where a check-in finishes, so staff can keep correcting one field
 * at a time on a record that is still missing others.
 */

const verified = { emailVerified: true, phoneVerified: true };

function check(row: Partial<Parameters<typeof assertPayoutIsCoherent>[0]>) {
  assertPayoutIsCoherent({
    method: null,
    target: null,
    handle: null,
    ...verified,
    ...row,
  });
}

describe('payout coherence', () => {
  describe('accepts every row of the table', () => {
    it('CHECK, with no destination', () => {
      expect(() => check({ method: 'CHECK' })).not.toThrow();
    });

    it('PAYPAL to a verified email', () => {
      expect(() => check({ method: 'PAYPAL', target: 'EMAIL' })).not.toThrow();
    });

    it('PAYPAL to a verified phone', () => {
      expect(() => check({ method: 'PAYPAL', target: 'PHONE' })).not.toThrow();
    });

    it('PAYPAL to a typed PayPal ID', () => {
      expect(() =>
        check({ method: 'PAYPAL', target: 'PAYPAL_ID', handle: 'chris@example.com' }),
      ).not.toThrow();
    });

    it('VENMO to a typed Venmo ID', () => {
      expect(() =>
        check({ method: 'VENMO', target: 'VENMO_ID', handle: '@chris-armenio' }),
      ).not.toThrow();
    });

    it('DONATE, with no destination', () => {
      expect(() => check({ method: 'DONATE' })).not.toThrow();
    });

    it('a seller who has not answered yet', () => {
      // Not complete, but not incoherent — and staff must be able to patch a
      // record in this state without being refused.
      expect(() => check({ method: null })).not.toThrow();
    });
  });

  describe('refuses a destination that does not belong to the method', () => {
    it('VENMO with a PayPal target', () => {
      expect(() =>
        check({ method: 'VENMO', target: 'PAYPAL_ID', handle: 'chris@example.com' }),
      ).toThrow(BadRequestException);
    });

    it('PAYPAL with a Venmo target', () => {
      expect(() =>
        check({ method: 'PAYPAL', target: 'VENMO_ID', handle: '@chris' }),
      ).toThrow(BadRequestException);
    });

    it('CHECK carrying a destination', () => {
      // A cheque goes to the address; a destination here means two answers
      // disagreeing about where the money went.
      expect(() => check({ method: 'CHECK', target: 'EMAIL' })).toThrow(BadRequestException);
    });

    it('DONATE carrying a destination', () => {
      expect(() =>
        check({ method: 'DONATE', target: 'PAYPAL_ID', handle: 'x@example.com' }),
      ).toThrow(BadRequestException);
    });
  });

  describe('refuses a value that does not match its target', () => {
    it('a typed target with no ID', () => {
      expect(() => check({ method: 'VENMO', target: 'VENMO_ID' })).toThrow(BadRequestException);
    });

    it('a typed target with a blank ID', () => {
      expect(() => check({ method: 'VENMO', target: 'VENMO_ID', handle: '   ' })).toThrow(
        BadRequestException,
      );
    });

    it('a verified target carrying a copy of the contact', () => {
      // The destination resolves from the contact when the money moves, so a
      // stored copy is a second answer that can go stale against the first.
      expect(() =>
        check({ method: 'PAYPAL', target: 'EMAIL', handle: 'chris@example.com' }),
      ).toThrow(BadRequestException);
    });
  });

  describe('refuses an unverified contact', () => {
    it('PAYPAL to an unverified email', () => {
      expect(() =>
        check({ method: 'PAYPAL', target: 'EMAIL', emailVerified: false }),
      ).toThrow(BadRequestException);
    });

    it('PAYPAL to an unverified phone', () => {
      expect(() =>
        check({ method: 'PAYPAL', target: 'PHONE', phoneVerified: false }),
      ).toThrow(BadRequestException);
    });

    it('but allows the other contact when only one is verified', () => {
      expect(() =>
        check({ method: 'PAYPAL', target: 'PHONE', emailVerified: false }),
      ).not.toThrow();
    });
  });
});
