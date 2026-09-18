import {
  PAYPAL_ITEM_STATUSES, buildRecipient, mapItemStatus, normaliseVenmoHandle,
} from './paypal-mapping';

describe('mapItemStatus', () => {
  /**
   * All nine, not a sample. A status that falls through to a default is a
   * status that reports money as delivered on the strength of a string nobody
   * has read.
   */
  it('lands every status PayPal defines', () => {
    for (const s of PAYPAL_ITEM_STATUSES) {
      expect(() => mapItemStatus(s)).not.toThrow();
    }
    expect(PAYPAL_ITEM_STATUSES).toHaveLength(9);
  });

  it('only SUCCESS means the money arrived', () => {
    expect(mapItemStatus('SUCCESS')).toEqual({ status: 'SENT', terminal: true });
    for (const s of PAYPAL_ITEM_STATUSES.filter((x) => x !== 'SUCCESS')) {
      expect(mapItemStatus(s).status).not.toBe('SENT');
    }
  });

  it('keeps in-flight apart from finished', () => {
    expect(mapItemStatus('PENDING')).toMatchObject({ status: 'SENDING', terminal: false });
    expect(mapItemStatus('ONHOLD')).toMatchObject({ status: 'SENDING', terminal: false });
    expect(mapItemStatus('UNCLAIMED')).toMatchObject({ status: 'UNCLAIMED', terminal: false });
  });

  it('says why, where PayPal gave a reason worth keeping', () => {
    expect(mapItemStatus('ONHOLD').note).toMatch(/review/);
    expect(mapItemStatus('BLOCKED').note).toMatch(/BLOCKED/);
    expect(mapItemStatus('REVERSED').note).toMatch(/REVERSED/);
  });

  /** The one that matters: a new PayPal status must stop a run, not pass. */
  it('throws on anything it has not been taught', () => {
    expect(() => mapItemStatus('SOMETHING_NEW')).toThrow(/Unrecognised/);
    expect(() => mapItemStatus('')).toThrow();
    expect(() => mapItemStatus('success')).toThrow();
  });

  /** `DENIED` is a batch status, not an item one. It must not quietly map. */
  it('does not accept a batch status as an item status', () => {
    expect(() => mapItemStatus('DENIED')).toThrow();
  });
});

describe('buildRecipient', () => {
  it('maps each PayPal destination to its recipient type', () => {
    expect(buildRecipient('PAYPAL', 'EMAIL', 'dana@example.com'))
      .toEqual({ recipient_type: 'EMAIL', receiver: 'dana@example.com' });
    expect(buildRecipient('PAYPAL', 'PHONE', '+15550101001'))
      .toEqual({ recipient_type: 'PHONE', receiver: '+15550101001' });
    expect(buildRecipient('PAYPAL', 'PAYPAL_ID', 'ABC123'))
      .toEqual({ recipient_type: 'PAYPAL_ID', receiver: 'ABC123' });
  });

  /** §11: the handle collected at check-in is payable as it stands. */
  it('sends a Venmo handle as USER_HANDLE, in the Venmo wallet', () => {
    expect(buildRecipient('VENMO', 'VENMO_ID', '@dana-reyes')).toEqual({
      recipient_type: 'USER_HANDLE',
      receiver: 'dana-reyes',
      recipient_wallet: 'Venmo',
    });
  });

  it('is the only one that names a wallet', () => {
    for (const t of ['EMAIL', 'PHONE', 'PAYPAL_ID'] as const) {
      expect(buildRecipient('PAYPAL', t, 'x')).not.toHaveProperty('recipient_wallet');
    }
  });

  it('refuses a method that does not go through PayPal', () => {
    expect(() => buildRecipient('CHECK', null, '')).toThrow(/do not go through PayPal/);
    expect(() => buildRecipient('DONATE', null, '')).toThrow();
  });

  it('refuses a PayPal payout with no destination type', () => {
    expect(() => buildRecipient('PAYPAL', null, 'dana@example.com')).toThrow(/destination type/);
  });
});

describe('normaliseVenmoHandle', () => {
  it('pays two sellers who typed it differently the same way', () => {
    expect(normaliseVenmoHandle('@dana')).toBe('dana');
    expect(normaliseVenmoHandle('dana')).toBe('dana');
    expect(normaliseVenmoHandle('  @dana  ')).toBe('dana');
    expect(normaliseVenmoHandle('@@dana')).toBe('dana');
  });
});
