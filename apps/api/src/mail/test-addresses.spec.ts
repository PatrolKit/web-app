import { MailService, isReservedTestAddress } from './mail.service';

/** The test org's `.invalid` addresses can never receive mail, so nothing is sent to them. */
describe('test addresses', () => {
  it('recognises the reserved .invalid domain, and nothing else', () => {
    expect(isReservedTestAddress('smoke-staff@patrolkit.invalid')).toBe(true);
    expect(isReservedTestAddress('Someone@Example.INVALID ')).toBe(true);
    expect(isReservedTestAddress('dana@gmail.com')).toBe(false);
    expect(isReservedTestAddress('invalid@gmail.com')).toBe(false);
    expect(isReservedTestAddress('dana@invalid.com')).toBe(false);
  });

  it('suppresses a send to one, whatever the settings, without reaching the provider', async () => {
    const config = { get: (key: string, fallback?: unknown) => (key === 'app.outboundNotifications' ? true : key === 'app.mailTransport' ? 'ses' : fallback) };
    const svc = new MailService(config as never, {} as never);
    const reached = jest.spyOn(svc as unknown as { sendViaSes: () => Promise<string> }, 'sendViaSes');
    await expect(svc.sendReceipt('receipt-smoke@patrolkit.invalid', 'Org', '<p>hi</p>'))
      .resolves.toEqual({ status: 'suppressed', reason: 'a .invalid test address, which can never receive mail' });
    expect(reached).not.toHaveBeenCalled();
  });
});
