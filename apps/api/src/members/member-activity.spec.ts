import { MembersService } from './members.service';

/** Last activity and signed-in, from each member's sessions. */
describe('members’ activity', () => {
  const member = (userId: string) => ({
    id: `m-${userId}`, userId, joinedAt: new Date(), deletedAt: null, inviteSentAt: null,
    user: { email: `${userId}@example.com`, emailVerifiedAt: null, phone: null, phoneVerifiedAt: null, firstName: userId, lastName: null },
    permissions: [], sellerProfile: null, patrollerProfile: null,
  });

  it('gives each member their newest session and whether one is still open', async () => {
    const recent = new Date('2026-10-06T10:00:00Z');
    const groupBys: Record<string, unknown>[] = [];
    const prisma = {
      membership: { findMany: async () => [member('dana'), member('sam'), member('lee')] },
      refreshToken: {
        groupBy: async (args: Record<string, unknown>) => {
          groupBys.push(args);
          return '_max' in args
            ? [{ userId: 'dana', _max: { createdAt: recent } }, { userId: 'sam', _max: { createdAt: new Date('2026-09-01') } }]
            : [{ userId: 'dana', _count: { _all: 1 } }];
        },
      },
    };
    const svc = new MembersService(prisma as never, {} as never, {} as never, {} as never, {} as never);
    const out = await svc.listMembers('org-1');
    expect(out.map((m) => [m.userId, m.lastActiveAt, m.signedIn])).toEqual([
      ['dana', recent, true],
      ['sam', new Date('2026-09-01'), false],
      ['lee', null, false],
    ]);
    // Open means not signed out and not expired.
    expect(groupBys[1]).toMatchObject({ where: { revokedAt: null, expiresAt: { gt: expect.any(Date) } } });
  });
});
