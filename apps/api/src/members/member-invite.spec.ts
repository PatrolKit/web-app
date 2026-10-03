import { MembersService } from './members.service';

/**
 * A member is told where and how to sign in by an invite email with no expiry,
 * whether they're invited from the form, from a file, or sent one by hand.
 */

describe('a member invite', () => {
  function members(user: { email: string | null; verifiedEmail: string | null }, status = 'sent') {
    const sent: { to: string; org: string }[] = [];
    const stamped: Record<string, unknown>[] = [];
    const prisma = {
      membership: {
        findUnique: async () => ({ id: 'membership-1', deletedAt: null, user, org: { name: 'BMBWAV Ski Patrol' } }),
        update: async ({ data }: { data: Record<string, unknown> }) => { stamped.push(data); return {}; },
        count: async () => 1,
      },
    };
    const mail = { sendMemberInvite: async (to: string, org: string) => { sent.push({ to, org }); return { status }; } };
    const unused = {} as never;
    return { svc: new MembersService(prisma as never, unused, unused, unused, mail as never), sent, stamped };
  }

  it('is emailed to the member’s address, naming the org, and recorded', async () => {
    const { svc, sent, stamped } = members({ email: 'dana@example.com', verifiedEmail: null });
    const result = await svc.sendInvite('org-1', 'user-1');
    expect(result).toMatchObject({ sentTo: 'dana@example.com', status: 'sent' });
    expect(result.inviteSentAt).toBeInstanceOf(Date);
    expect(sent).toEqual([{ to: 'dana@example.com', org: 'BMBWAV Ski Patrol' }]);
    expect(stamped).toEqual([{ inviteSentAt: result.inviteSentAt }]);
  });

  it('isn’t recorded when outgoing email is switched off', async () => {
    const { svc, stamped } = members({ email: 'dana@example.com', verifiedEmail: null }, 'suppressed');
    await expect(svc.sendInvite('org-1', 'user-1')).resolves.toMatchObject({ status: 'suppressed', inviteSentAt: null });
    expect(stamped).toEqual([]);
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
    const prisma = {
      organization: { findUniqueOrThrow: async () => ({ name: 'BMBWAV Ski Patrol' }) },
      membership: { update: async () => ({}) },
    };
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

describe('who the Members page is for', () => {
  /** One existing person here, who is a seller and nothing else. */
  function withSeller() {
    let listedWhere: Record<string, unknown> | undefined;
    const granted: string[][] = [];
    const prisma = {
      organization: { findUniqueOrThrow: async () => ({ name: 'BMBWAV Ski Patrol' }) },
      membership: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => { listedWhere = where; return []; },
        findUnique: async () => ({ id: 'membership-1', deletedAt: null }),
        // Only a seller, so never a member.
        count: async () => 0,
        update: async () => ({}),
      },
    };
    const people = {
      resolve: async () => ({ id: 'user-1' }),
      resolveOrCreate: async () => ({ user: { id: 'user-1', email: 'sam@example.com' } }),
      upsertMembership: async () => ({ id: 'membership-1' }),
    };
    const permissions = { invalidate: () => undefined };
    const mail = { sendMemberInvite: async () => ({ status: 'sent' }) };
    const svc = new MembersService(prisma as never, permissions as never, people as never, {} as never, mail as never);
    const internals = svc as unknown as { getMemberResponse: () => Promise<object>; assignPermissions: (id: string, keys: string[]) => Promise<void> };
    internals.getMemberResponse = async () => ({});
    internals.assignPermissions = async (_id, keys) => { granted.push(keys); };
    return { svc, granted, listed: () => listedWhere };
  }

  it('leaves out anyone who is only a seller here', async () => {
    const { svc, listed } = withSeller();
    await svc.listMembers('org-1');
    expect(listed()).toMatchObject({
      orgId: 'org-1',
      OR: expect.arrayContaining([
        { sellerProfile: { is: null } },
        { patrollerProfile: { is: { deletedAt: null } } },
        { permissions: { some: {} } },
      ]),
    });
  });

  it('won’t invite a seller as a member with nothing to do', async () => {
    const { svc } = withSeller();
    await expect(svc.inviteMember('org-1', 'admin-1', { email: 'sam@example.com', permissions: [] } as never))
      .rejects.toThrow(/ski swap seller here, not a member/);
  });

  it('makes a seller a member when they’re given permissions', async () => {
    const { svc, granted } = withSeller();
    await svc.inviteMember('org-1', 'admin-1', { email: 'sam@example.com', permissions: ['users:invite'] } as never);
    expect(granted).toEqual([['users:invite']]);
  });

  it('treats a file the same way, row by row', async () => {
    const { svc, granted } = withSeller();
    const file = Buffer.from('email,permissions\nsam@example.com,\nsam@example.com,users:invite\n');
    const outcomes = await svc.bulkImport('org-1', file, false);
    expect(outcomes.map((o) => o.outcome)).toEqual(['error', 'created']);
    expect(outcomes[0].error).toMatch(/not a member/);
    expect(granted).toEqual([['users:invite']]);
  });

  it('won’t send a member invite to someone who is only a seller', async () => {
    const { svc } = withSeller();
    await expect(svc.sendInvite('org-1', 'user-1')).rejects.toThrow(/Member not found/);
  });
});
