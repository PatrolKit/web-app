import { MailService } from './mail.service';

const sent: unknown[] = [];
jest.mock('@aws-sdk/client-ses', () => {
  const actual = jest.requireActual('@aws-sdk/client-ses');
  return {
    ...actual,
    SESClient: jest.fn().mockImplementation(() => ({ send: async (cmd: unknown) => { sent.push(cmd); return { MessageId: 'ses-1' }; } })),
  };
});

/** An Items export by email: SES can't attach a file to a simple send, so it goes raw. */
describe('emailing an Items export', () => {
  const config = (over: Record<string, unknown> = {}) => ({
    get: (k: string, d?: unknown) => ({ 'app.mailTransport': 'ses', 'app.outboundNotifications': true, 'app.emailFrom': 'noreply@patrolkit.io', ...over })[k] ?? d,
  });
  const prisma = { user: { findMany: async () => [] }, membership: { findMany: async () => [] } };
  const file = { filename: 'fall-swap-items.xlsx', content: Buffer.from('PK fake xlsx'), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

  beforeEach(() => { sent.length = 0; });

  it('sends one raw message with the spreadsheet attached', async () => {
    const mail = new MailService(config() as never, prisma as never);
    const outcome = await mail.sendItemsExport('treasurer@example.com', { orgName: 'BMBW', swapTitle: 'Fall Swap', senderName: 'Pat Admin', items: 12, filters: 'Sold', file });
    expect(outcome).toEqual({ status: 'sent', providerRef: 'ses-1' });
    expect(sent).toHaveLength(1);
    const cmd = sent[0] as { constructor: { name: string }; input: { Destinations: string[]; RawMessage: { Data: Buffer } } };
    expect(cmd.constructor.name).toBe('SendRawEmailCommand');
    expect(cmd.input.Destinations).toEqual(['treasurer@example.com']);
    const raw = cmd.input.RawMessage.Data.toString('utf8');
    expect(raw).toContain('filename=fall-swap-items.xlsx');
    expect(raw).toContain('Subject: BMBW: Fall Swap items spreadsheet');
    expect(raw).toContain('Pat Admin sent you the items of Fall Swap');
  });

  it('sends nothing while outbound mail is off, and says so', async () => {
    const mail = new MailService(config({ 'app.outboundNotifications': false }) as never, prisma as never);
    const outcome = await mail.sendItemsExport('treasurer@example.com', { orgName: 'BMBW', swapTitle: 'Fall Swap', senderName: 'Pat', items: 1, filters: '', file });
    expect(outcome.status).toBe('suppressed');
    expect(sent).toHaveLength(0);
  });
});
