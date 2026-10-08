import { BadRequestException, ConflictException } from '@nestjs/common';
import { PlatformService } from './platform.service';

/**
 * Creating an org invites its owner the way Members invites anyone: a new
 * patrol's owner usually has no PatrolKit account yet, and gets one.
 */
function harness(opts: { existingUser?: { id: string; email: string }; slugTaken?: boolean; mail?: 'sent' | 'suppressed'; claimRefused?: boolean } = {}) {
  const created: { orgs: { id: string; name: string; slug: string }[]; users: string[] } = { orgs: [], users: [] };
  const membershipUpdates: Record<string, unknown>[] = [];
  const sentTo: string[] = [];
  const prisma = {
    organization: {
      findUnique: async () => (opts.slugTaken ? { id: 'taken' } : null),
      create: async ({ data }: { data: { id: string; name: string; slug: string } }) => {
        created.orgs.push(data);
        return { ...data, status: 'active', createdAt: new Date('2026-10-08') };
      },
    },
    permission: { findMany: async () => [{ id: 'p1' }, { id: 'p2' }] },
    membershipPermission: { createMany: async () => ({ count: 2 }) },
    orgModule: { create: async () => ({}) },
    membership: { update: async ({ data }: { data: Record<string, unknown> }) => { membershipUpdates.push(data); return {}; } },
  };
  const people = {
    resolveOrCreate: async ({ email }: { email: string }) => {
      if (opts.claimRefused) throw new BadRequestException('That email is someone else’s verified address');
      if (opts.existingUser) return { user: opts.existingUser, created: false };
      created.users.push(email);
      return { user: { id: 'u-new', email }, created: true };
    },
    upsertMembership: async () => ({ id: 'm1' }),
  };
  const mail = { sendMemberInvite: async (to: string) => { sentTo.push(to); return { status: opts.mail ?? 'sent' }; } };
  const service = new PlatformService(prisma as never, people as never, mail as never);
  return { service, created, membershipUpdates, sentTo };
}

const REQ = { name: 'Mountain Ski Patrol', slug: 'mountain-ski-patrol', ownerEmail: 'owner+test@example.com' };

describe('creating an organization', () => {
  it('gives an owner with no account one, and emails the invite', async () => {
    const t = harness();
    const out = await t.service.createOrg(REQ);
    expect(t.created.users).toEqual(['owner+test@example.com']);
    expect(t.sentTo).toEqual(['owner+test@example.com']);
    expect(out.owner).toEqual({ email: 'owner+test@example.com', created: true, invite: 'sent' });
    expect(t.membershipUpdates[0]).toHaveProperty('inviteSentAt');
  });

  it('makes an existing user the owner, and tells them', async () => {
    const t = harness({ existingUser: { id: 'u1', email: 'owner+test@example.com' } });
    const out = await t.service.createOrg(REQ);
    expect(t.created.users).toEqual([]);
    expect(out.owner).toMatchObject({ created: false, invite: 'sent' });
  });

  it('still creates the org when the invite isn’t sent, and says so', async () => {
    const t = harness({ mail: 'suppressed' });
    const out = await t.service.createOrg(REQ);
    expect(t.created.orgs).toHaveLength(1);
    expect(out.owner.invite).toBe('not_sent');
    expect(t.membershipUpdates).toEqual([]);
  });

  it('refuses a taken slug, and an email that’s someone else’s, before making anything', async () => {
    const taken = harness({ slugTaken: true });
    await expect(taken.service.createOrg(REQ)).rejects.toBeInstanceOf(ConflictException);
    const refused = harness({ claimRefused: true });
    await expect(refused.service.createOrg(REQ)).rejects.toBeInstanceOf(BadRequestException);
    expect(refused.created.orgs).toEqual([]);
  });
});
