import { looksLikeOurSku, normalizedTicket, takenRejection, ticketScanRejection } from './legacy-ticket-scan';

/** The same checks as the iPad's `LegacyTicketRules`, in the same order (Plan 40 D7). */
describe('a scanned legacy ticket', () => {
  const batch = new Set(['501']);

  it('is trimmed, and nothing is nothing', () => {
    expect(normalizedTicket('  67169\r')).toBe('67169');
    expect(normalizedTicket('   ')).toBeNull();
  });

  it('refuses our own tags first, then anything not all digits, then a repeat', () => {
    expect(ticketScanRejection('SS26-A-0001', batch)?.key).toBe('ourTag');
    expect(ticketScanRejection('SS26-0001', batch)?.key).toBe('notDigits');
    expect(ticketScanRejection('0123456789012', batch)).toBeNull();
    expect(ticketScanRejection('501', batch)).toMatchObject({ key: 'inBatch', ticket: '501' });
    expect(ticketScanRejection('67169', batch)).toBeNull();
  });

  it('tells our tags by shape, as the iPad does', () => {
    expect(looksLikeOurSku('BMB-A-12')).toBe(true);
    expect(looksLikeOurSku('BMB-AB-12')).toBe(false);
    expect(looksLikeOurSku('67169')).toBe(false);
  });

  it('says whose a taken ticket is, in the server’s words', () => {
    expect(takenRejection('67169', 'Stowe Sports')).toMatchObject({ headline: 'Already taken', advice: 'Ticket 67169 belongs to Stowe Sports.' });
    expect(takenRejection('67169', null).headline).toBe('Already checked in');
  });
});
