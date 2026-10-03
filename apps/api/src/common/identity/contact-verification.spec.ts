import { unverifyChangedContacts } from './contact-verification';

/** Changing a contact unverifies it, unless it's changed to the address proven. */
describe('a contact change', () => {
  const verified = {
    email: 'dana@example.com', emailVerifiedAt: new Date(), verifiedEmail: 'dana@example.com',
    phone: '+18025550142', phoneVerifiedAt: new Date(), verifiedPhone: '+18025550142',
  };

  it('to a new email unverifies the email, and leaves the phone', () => {
    expect(unverifyChangedContacts(verified, { email: 'dana@new.example' }))
      .toEqual({ emailVerifiedAt: null, verifiedEmail: null });
  });

  it('to a new phone unverifies the phone, and leaves the email', () => {
    expect(unverifyChangedContacts(verified, { phone: '+18025550199' }))
      .toEqual({ phoneVerifiedAt: null, verifiedPhone: null });
  });

  it('that clears the contact unverifies it', () => {
    expect(unverifyChangedContacts(verified, { email: null, phone: null })).toEqual({
      emailVerifiedAt: null, verifiedEmail: null, phoneVerifiedAt: null, verifiedPhone: null,
    });
  });

  it('to the address already proven changes nothing, whatever its case', () => {
    expect(unverifyChangedContacts(verified, { email: 'Dana@Example.com', phone: '+18025550142' })).toEqual({});
  });

  it('that doesn’t touch the contact changes nothing', () => {
    expect(unverifyChangedContacts(verified, {})).toEqual({});
  });

  it('of an unverified contact has nothing to clear', () => {
    const unverified = { ...verified, emailVerifiedAt: null, verifiedEmail: null };
    expect(unverifyChangedContacts(unverified, { email: 'dana@new.example' })).toEqual({});
  });
});
