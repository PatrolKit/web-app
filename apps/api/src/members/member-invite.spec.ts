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
    return { svc: new MembersService(prisma as never, unused, unused, unused, mail as never, unused), sent, stamped };
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

/** A MembersService over stand-ins, recording what it asks of people and Prisma. */
function harness(opts: { existing?: { id: string; nspId?: string | null } | null; isMember?: boolean } = {}) {
  const sent: { to: string; org: string }[] = [];
  const granted: string[][] = [];
  const records: string[] = [];
  let listedWhere: Record<string, unknown> | undefined;
  const prisma = {
    organization: { findUniqueOrThrow: async () => ({ name: 'BMBWAV Ski Patrol' }) },
    membership: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => { listedWhere = where; return []; },
      findUnique: async () => (opts.existing ? { id: 'membership-1', deletedAt: null } : null),
      count: async () => (opts.isMember ? 1 : 0),
      update: async () => ({}),
    },
    timeEntry: { findMany: async () => [] },
    user: { update: async () => ({}) },
    patrollerProfile: { update: async () => ({}), updateMany: async () => ({ count: 0 }) },
    auditLog: { create: async () => ({}) },
  };
  const people = {
    resolve: async () => opts.existing ?? null,
    resolveOrCreate: async ({ email }: { email?: string }) => ({ user: { id: opts.existing?.id ?? `user-${email}`, email: email ?? null } }),
    upsertMembership: async () => ({ id: 'membership-1' }),
    ensureMemberRecord: async (id: string) => { records.push(id); },
  };
  const permissions = { invalidate: () => undefined };
  const touch = { touchAllForUser: async () => undefined, touch: async () => undefined };
  const mail = { sendMemberInvite: async (to: string, org: string) => { sent.push({ to, org }); return { status: 'sent' }; } };
  const entries = { closeFor: async () => null };
  const svc = new MembersService(prisma as never, permissions as never, people as never, touch as never, mail as never, entries as never);
  const internals = svc as unknown as { getMemberResponse: () => Promise<object>; assignPermissions: (id: string, keys: string[]) => Promise<void> };
  internals.getMemberResponse = async () => ({ permissions: [], removedAt: null });
  internals.assignPermissions = async (_id, keys) => { granted.push(keys); };
  return { svc, sent, granted, records, listed: () => listedWhere };
}

const row = (r: Record<string, string>) => r;

describe('adding members', () => {
  it('from the form sends the invite email, not a sign-in link', async () => {
    const { svc, sent } = harness();
    await svc.inviteMember('org-1', 'admin-1', { email: 'dana@example.com', permissions: [] } as never);
    expect(sent).toEqual([{ to: 'dana@example.com', org: 'BMBWAV Ski Patrol' }]);
  });

  it('gives every new member a member record (Plan 57 D2)', async () => {
    const { svc, records } = harness();
    await svc.inviteMember('org-1', 'admin-1', { firstName: 'Tom', lastName: 'Anderson', nspId: '100006', permissions: [] } as never);
    expect(records).toEqual(['membership-1']);
  });

  it('from a file sends it only when asked', async () => {
    const quiet = harness();
    await quiet.svc.importRows('org-1', 'admin-1', { rows: [row({ email: 'a@example.com', firstName: 'Pat' })], strategy: 'preserve', sendInvites: false });
    expect(quiet.sent).toEqual([]);

    const loud = harness();
    const outcomes = await loud.svc.importRows('org-1', 'admin-1', {
      rows: [row({ email: 'a@example.com' }), row({ email: 'b@example.com' })], strategy: 'preserve', sendInvites: true,
    });
    expect(outcomes.map((o) => o.outcome)).toEqual(['invited', 'invited']);
    expect(loud.sent.map((s) => s.to)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('takes a row with no contact when it has a name and an NSP ID (D4)', async () => {
    const { svc } = harness();
    const outcomes = await svc.importRows('org-1', 'admin-1', {
      rows: [row({ firstName: 'Tom', lastName: 'Anderson', nspId: '100006' }), row({ firstName: 'Nobody' })],
      strategy: 'preserve', sendInvites: false,
    });
    expect(outcomes.map((o) => o.outcome)).toEqual(['created', 'error']);
    expect(outcomes[1].error).toMatch(/email, a phone number or an NSP ID/);
  });

  it('leaves an existing member alone unless asked to overwrite', async () => {
    const preserve = harness({ existing: { id: 'user-1' }, isMember: true });
    const kept = await preserve.svc.importRows('org-1', 'admin-1', { rows: [row({ email: 'a@example.com' })], strategy: 'preserve', sendInvites: false });
    expect(kept.map((o) => o.outcome)).toEqual(['already_member']);

    const overwrite = harness({ existing: { id: 'user-1' }, isMember: true });
    const updated = await overwrite.svc.importRows('org-1', 'admin-1', { rows: [row({ email: 'a@example.com', patrolLevel: 'Senior' })], strategy: 'overwrite', sendInvites: false });
    expect(updated.map((o) => o.outcome)).toEqual(['updated']);
  });
});

describe('who the Members page is for', () => {
  it('lists members by their record or their permissions, never a seller alone', async () => {
    const { svc, listed } = harness();
    await svc.listMembers('org-1');
    expect(listed()).toMatchObject({
      orgId: 'org-1',
      OR: [
        { patrollerProfile: { is: { deletedAt: null } } },
        { permissions: { some: {} } },
      ],
    });
  });

  it('makes a seller a member by adding them', async () => {
    const { svc, records } = harness({ existing: { id: 'user-1' }, isMember: false });
    await svc.inviteMember('org-1', 'admin-1', { email: 'sam@example.com', permissions: [] } as never);
    expect(records).toEqual(['membership-1']);
  });

  it('makes a seller a member by giving them permissions', async () => {
    const { svc, granted, records } = harness({ existing: { id: 'user-1' }, isMember: false });
    await svc.inviteMember('org-1', 'admin-1', { email: 'sam@example.com', permissions: ['users:invite'] } as never);
    expect(granted).toEqual([['users:invite']]);
    expect(records).toEqual(['membership-1']);
  });

  it('refuses to add someone already a member', async () => {
    const { svc } = harness({ existing: { id: 'user-1' }, isMember: true });
    await expect(svc.inviteMember('org-1', 'admin-1', { email: 'sam@example.com', permissions: [] } as never))
      .rejects.toThrow(/already a member/);
  });

  it('won’t send a member invite to someone who is only a seller', async () => {
    const { svc } = harness({ existing: { id: 'user-1' }, isMember: false });
    await expect(svc.sendInvite('org-1', 'user-1')).rejects.toThrow(/Member not found/);
  });
});
