import nodemailer from 'nodemailer';
import { MailService } from './mail.service';
import { formatSender, senderAddress } from './sender';
import { plainText } from './plain-text';
import { receiptEmail } from '../ski-swap/receipt-templates';

/**
 * Two things every outgoing email now carries, for spam filters and for the
 * person reading it: a From name they recognize, and a plain-text part.
 */

jest.mock('nodemailer');

type Sent = { from: string; to: string; subject: string; html: string; text: string };

function build(people: { email: string; orgs: string[] }[]) {
  const sent: Sent[] = [];
  (nodemailer.createTransport as jest.Mock).mockReturnValue({
    sendMail: async (m: Sent) => { sent.push(m); return { messageId: 'm1' }; },
  });
  const config = {
    get: (k: string, d?: unknown) => ({ 'app.outboundNotifications': true, 'app.mailTransport': 'smtp', 'app.emailFrom': 'noreply@patrolkit.io' } as Record<string, unknown>)[k] ?? d,
  };
  const prisma = {
    user: {
      findMany: async ({ where }: { where: { OR: { email?: string; verifiedEmail?: string }[] } }) => {
        const email = where.OR[0].verifiedEmail;
        return people.filter((p) => p.email === email).map((p, i) => ({ id: `${p.email}#${i}` }));
      },
    },
    membership: {
      findMany: async ({ where }: { where: { userId: string } }) => {
        const [email, i] = where.userId.split('#');
        return people.filter((p) => p.email === email)[Number(i)].orgs.map((name) => ({ org: { name } }));
      },
    },
  };
  return { mail: new MailService(config as never, prisma as never), sent };
}

describe('the From name', () => {
  it("is the recipient's club when they belong to exactly one", async () => {
    const { mail, sent } = build([{ email: 'dana@example.com', orgs: ['BMBWAV Ski Patrol'] }]);
    await mail.sendMagicLink('Dana@Example.com', 'https://patrolkit.io/app/auth/verify?t=x');
    expect(sent[0].from).toBe('"BMBWAV Ski Patrol" <noreply@patrolkit.io>');
  });

  it('is PatrolKit for someone in several clubs, in none, or unknown', async () => {
    const { mail, sent } = build([
      { email: 'two@example.com', orgs: ['A Patrol', 'B Patrol'] },
      { email: 'none@example.com', orgs: [] },
    ]);
    for (const to of ['two@example.com', 'none@example.com', 'stranger@example.com']) {
      await mail.sendVerificationEmail(to, 'https://patrolkit.io/v');
    }
    expect(sent.map((m) => m.from)).toEqual(Array(3).fill('"PatrolKit" <noreply@patrolkit.io>'));
  });

  it('is PatrolKit when two people claim the address, rather than guessing which', async () => {
    const { mail, sent } = build([
      { email: 'shared@example.com', orgs: ['A Patrol'] },
      { email: 'shared@example.com', orgs: ['B Patrol'] },
    ]);
    await mail.sendMagicLink('shared@example.com', 'https://patrolkit.io/x');
    expect(sent[0].from).toBe('"PatrolKit" <noreply@patrolkit.io>');
  });
});

describe('formatSender', () => {
  it('quotes and escapes a plain name', () => {
    expect(formatSender('Stowe "Mountain" Patrol', 'noreply@patrolkit.io')).toBe('"Stowe \\"Mountain\\" Patrol" <noreply@patrolkit.io>');
  });

  it('encodes a name that is not ASCII', () => {
    const from = formatSender('Mont-Sainte-Anne Patrouille Québec', 'noreply@patrolkit.io');
    expect(from).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <noreply@patrolkit\.io>$/);
    expect(Buffer.from(from.split('?')[3], 'base64').toString('utf8')).toBe('Mont-Sainte-Anne Patrouille Québec');
  });

  it('cannot be used to add a header', () => {
    expect(formatSender('Club\r\nBcc: someone@evil.example', 'noreply@patrolkit.io')).not.toMatch(/[\r\n]/);
  });

  it('takes the address out of a configured sender that already has a name', () => {
    expect(senderAddress('PatrolKit <noreply@patrolkit.io>')).toBe('noreply@patrolkit.io');
    expect(senderAddress('noreply@patrolkit.io')).toBe('noreply@patrolkit.io');
  });
});

describe('the plain-text part', () => {
  it('goes with every email, and keeps the link a reader has to follow', async () => {
    const { mail, sent } = build([]);
    await mail.sendMagicLink('x@example.com', 'https://patrolkit.io/app/auth/verify?t=abc123', { name: 'BMBWAV' });
    expect(sent[0].text).toContain('https://patrolkit.io/app/auth/verify?t=abc123');
    expect(sent[0].text).not.toMatch(/<[a-z]/i);
  });

  it('keeps a receipt readable: every item, its price, and the total', () => {
    const text = plainText(receiptEmail({
      id: 'r1', token: 't', orgName: 'Stowe Patrol', orgLogoUrl: null, logoImageUrl: null, swapTitle: 'Fall Swap',
      sellerName: 'Dana Reyes', payoutLabel: 'Check', totalCents: 13500, itemCount: 2, unpricedCount: 0,
      createdAt: new Date('2026-09-17T13:42:00Z'), timeZone: 'America/New_York', url: 'https://skiswap.patrolkit.io/r/t',
      trackUrl: 'https://skiswap.patrolkit.io/s/seller123', brandMarkUrl: 'https://skiswap.patrolkit.io/logo-mark.png',
      layout: { mode: 'ITEMIZED', show: { sku: true, name: true, price: true }, link: { url: 'https://skiswap.patrolkit.io/s/seller123', kind: 'SELLER_STATUS' }, print: { paperSize: '62x100' }, finePrint: null },
      lines: [
        { name: 'Rossignol 172cm Red Skis', sku: 'ETR-E-0001', priceCents: 4500 },
        { name: 'Snowboard', sku: 'ETR-E-0002', priceCents: 9000 },
      ],
    }));
    for (const want of ['Rossignol 172cm Red Skis', 'ETR-E-0001', '$45', 'Snowboard', '$135']) expect(text).toContain(want);
  });
});

describe('plain text layout', () => {
  it('never leaves more than one blank line in a row', () => {
    expect(plainText('<table><tr><td><img src="x"></td></tr><tr><td></td></tr></table><p>A</p><p></p><p></p><p>B</p>')).not.toMatch(/\n{3,}/);
  });
});
