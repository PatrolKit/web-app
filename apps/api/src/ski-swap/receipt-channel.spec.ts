import { BadRequestException } from '@nestjs/common';
import { resolveChannel } from './receipt.service';

/**
 * Which channel a receipt goes out on (Plan 24, Ask D).
 *
 * The default was the whole behaviour until the iPad grew a Print / Email /
 * Text menu, where one row per channel has to mean what it says. So there are
 * two things to hold still at once: a caller who names a channel gets it, and a
 * caller who names none gets exactly what the web has always got.
 */

const EMAIL = 'dana@example.com';
const PHONE = '+15550000000';

const both = { verifiedEmail: EMAIL, verifiedPhone: PHONE };
const emailOnly = { verifiedEmail: EMAIL, verifiedPhone: null };
const phoneOnly = { verifiedEmail: null, verifiedPhone: PHONE };
const neither = { verifiedEmail: null, verifiedPhone: null };

describe('receipt channel', () => {
  describe('with no channel asked for, resolves as it always has', () => {
    it('prefers a verified email', () => {
      expect(resolveChannel(null, both, true)).toBe('EMAIL');
    });

    it('falls back to a verified phone', () => {
      expect(resolveChannel(null, phoneOnly, true)).toBe('SMS');
    });

    it('refuses a seller with neither', () => {
      expect(() => resolveChannel(null, neither, true)).toThrow(BadRequestException);
    });
  });

  describe('with a channel asked for, uses it', () => {
    it('texts a seller who also has a verified email', () => {
      // The case the menu was built around: Text must not send an email.
      expect(resolveChannel('SMS', both, true)).toBe('SMS');
    });

    it('emails a seller who also has a verified phone', () => {
      expect(resolveChannel('EMAIL', both, true)).toBe('EMAIL');
    });

    it('agrees with the default when there is only one contact', () => {
      expect(resolveChannel('SMS', phoneOnly, true)).toBe('SMS');
      expect(resolveChannel('EMAIL', emailOnly, true)).toBe('EMAIL');
    });
  });

  describe('never reaches an unverified contact', () => {
    it('refuses SMS for a seller whose phone is not proved', () => {
      expect(() => resolveChannel('SMS', emailOnly, true)).toThrow(BadRequestException);
    });

    it('refuses EMAIL for a seller whose email is not proved', () => {
      expect(() => resolveChannel('EMAIL', phoneOnly, true)).toThrow(BadRequestException);
    });

    it('says which contact is missing, rather than that both are', () => {
      // A volunteer acts on this sentence. Told "no verified email or phone"
      // after tapping Text, they would not then try Email — which would work.
      expect(() => resolveChannel('SMS', emailOnly, true)).toThrow(/no verified phone/);
      expect(() => resolveChannel('EMAIL', phoneOnly, true)).toThrow(/no verified email,/);
    });

    it('keeps the old sentence when the seller has nothing at all', () => {
      expect(() => resolveChannel('SMS', neither, true)).toThrow(
        'This seller has no verified email or phone, so there is nowhere to send a receipt.',
      );
    });
  });
});

describe('receipt channel with texting off (Plan 29)', () => {
  it('never picks a text, even for a phone verified before', () => {
    expect(resolveChannel(null, both, false)).toBe('EMAIL');
    expect(() => resolveChannel(null, phoneOnly, false)).toThrow(
      'This seller has no verified email, so there is nowhere to send a receipt.',
    );
  });

  it('refuses a text when asked, saying what to do instead', () => {
    for (const contacts of [both, phoneOnly, neither]) {
      expect(() => resolveChannel('SMS', contacts, false)).toThrow('Texting is off. Send it by email.');
    }
  });
});
