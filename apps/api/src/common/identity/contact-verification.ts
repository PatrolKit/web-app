/**
 * What a contact change does to its verification.
 *
 * A verification proves one address, the one in `verifiedEmail` /
 * `verifiedPhone`. Change the contact to anything else and it's unproven: the
 * stamp and the mirror are both cleared, so nothing shows the new address as
 * verified, and receipts and payouts stop going to the old one. Changing it to
 * the address already verified changes nothing.
 *
 * Returns the fields to add to the same `user.update` that writes the contact.
 */
export function unverifyChangedContacts(
  current: {
    email: string | null; emailVerifiedAt: Date | null; verifiedEmail: string | null;
    phone: string | null; phoneVerifiedAt: Date | null; verifiedPhone: string | null;
  },
  next: { email?: string | null; phone?: string | null },
): { emailVerifiedAt?: null; verifiedEmail?: null; phoneVerifiedAt?: null; verifiedPhone?: null } {
  const provenEmail = current.verifiedEmail ?? (current.emailVerifiedAt ? current.email : null);
  const provenPhone = current.verifiedPhone ?? (current.phoneVerifiedAt ? current.phone : null);
  const emailMoved = next.email !== undefined && provenEmail !== null &&
    (next.email ?? '').trim().toLowerCase() !== provenEmail.toLowerCase();
  const phoneMoved = next.phone !== undefined && provenPhone !== null && (next.phone ?? '') !== provenPhone;
  return {
    ...(emailMoved ? { emailVerifiedAt: null, verifiedEmail: null } : {}),
    ...(phoneMoved ? { phoneVerifiedAt: null, verifiedPhone: null } : {}),
  };
}
