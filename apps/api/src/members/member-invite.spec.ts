import { MembersService } from './members.service';

/**
 * A member is told where and how to sign in by an invite email with no expiry,
 * whether they're invited from the form, from a file, or sent one by hand.
 */

describe('a member invite', () => {
  function members(user: { email: string | null; verifiedEmail: string | null }) {
    const sent: { to: string; org: string }[] = [];
    const prisma = {
      membership: { findUnique: async () => ({ deletedAt: null, user, org: { name: 'BMBWAV Ski Patrol' } }) },
    };
    const mail = { sendMemberInvite: async (to: string, org: string) => { sent.push({ to, org }); return { status: 'sent' }; } };
    const unused = {} as never;
    return { svc: new MembersService(prisma as never, unused, unused, unused, mail as never), sent };
  }

  it('is emailed to the member’s address, naming the org', async () => {
    const { svc, sent } = members({ email: 'dana@example.com', verifiedEmail: null });
    await expect(svc.sendInvite('org-1', 'user-1')).resolves.toEqual({ sentTo: 'dana@example.com', status: 'sent' });
    expect(sent).toEqual([{ to: 'dana@example.com', org: 'BMBWAV Ski Patrol' }]);
  });

  it('is refused for a member with no email', async () => {
    const { svc, sent } = members({ email: null, verifiedEmail: null });
    await expect(svc.sendInvite('org-1', 'user-1')).rejects.toThrow(/no email address/);
    expect(sent).toEqual([]);
  });
});

describe('adding members', () => {
  function adder() {
    const sent: { to: string; org: string }[] = [];
    const prisma = { organization: { findUniqueOrThrow: async () => ({ name: 'BMBWAV Ski Patrol' }) } };
    const people = {
      resolve: async () => null,
      resolveOrCreate: async ({ email }: { email?: string }) => ({ user: { id: `user-${email}`, email: email ?? null } }),
      upsertMembership: async () => ({ id: 'membership-1' }),
    };
    const permissions = { invalidate: () => undefined };
    const mail = { sendMemberInvite: async (to: string, org: string) => { sent.push({ to, org }); return { status: 'sent' }; } };
    const svc = new MembersService(prisma as never, permissions as never, people as never, {} as never, mail as never);
    (svc as unknown as { getMemberResponse: () => Promise<object> }).getMemberResponse = async () => ({});
    return { svc, sent };
  }
  const csv = (rows: string[]) => Buffer.from('email,firstName\n' + rows.map((e) => `${e},Pat`).join('\n'));

  it('from the form sends the invite email, not a sign-in link', async () => {
    const { svc, sent } = adder();
    await svc.inviteMember('org-1', 'admin-1', { email: 'dana@example.com', permissions: [] } as never);
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([{ to: 'dana@example.com', org: 'BMBWAV Ski Patrol' }]);
  });

  it('from a file sends it only when asked', async () => {
    const quiet = adder();
    await quiet.svc.bulkImport('org-1', csv(['a@example.com']), false);
    expect(quiet.sent).toEqual([]);

    const loud = adder();
    const outcomes = await loud.svc.bulkImport('org-1', csv(['a@example.com', 'b@example.com']), true);
    await new Promise((r) => setImmediate(r));
    expect(outcomes.map((o) => o.outcome)).toEqual(['invited', 'invited']);
    expect(loud.sent.map((s) => s.to)).toEqual(['a@example.com', 'b@example.com']);
  });
});
