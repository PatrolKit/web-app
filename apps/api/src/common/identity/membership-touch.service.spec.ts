import { MembershipTouchService } from './membership-touch.service';
import { PersonService } from './person.service';
import type { PrismaService } from '../../prisma/prisma.service';

/** The mocks are deliberately loose so jest matchers stay visible; the cast is the seam. */
const asPrisma = (m: unknown): PrismaService => m as PrismaService;

/**
 * `Membership.updatedAt` is the only watermark offline devices poll, and a
 * roster row is assembled from three tables. These tests pin the invariant that
 * a write to the *person* moves the watermark on every membership they hold —
 * the one failure mode that would silently strand a device on stale data.
 */
describe('MembershipTouchService', () => {
  function makePrisma() {
    return {
      membership: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        upsert: jest.fn().mockResolvedValue({ id: 'm1' }),
      },
      sellerProfile: { findUnique: jest.fn() },
      patrollerProfile: { findUnique: jest.fn() },
      user: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    };
  }

  it('touch() stamps the named membership', async () => {
    const prisma = makePrisma();
    await new MembershipTouchService(asPrisma(prisma)).touch('m1');

    expect(prisma.membership.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm1' }, data: { updatedAt: expect.any(Date) } }),
    );
  });

  it('touchAllForUser() stamps every membership that person holds', async () => {
    const prisma = makePrisma();
    await new MembershipTouchService(asPrisma(prisma)).touchAllForUser('u1');

    // Scoped by userId only — a rename affects the person at every org.
    expect(prisma.membership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1' }, data: { updatedAt: expect.any(Date) } }),
    );
  });

  it('resolves a profile to its membership before stamping', async () => {
    const prisma = makePrisma();
    prisma.patrollerProfile.findUnique.mockResolvedValue({ membershipId: 'm9' });

    await new MembershipTouchService(asPrisma(prisma)).touchByPatrollerProfile('p1');

    expect(prisma.membership.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm9' } }),
    );
  });

  it('does not stamp when the profile is already gone', async () => {
    const prisma = makePrisma();
    prisma.sellerProfile.findUnique.mockResolvedValue(null);

    await new MembershipTouchService(asPrisma(prisma)).touchBySellerProfile('gone');

    expect(prisma.membership.update).not.toHaveBeenCalled();
  });
});

describe('PersonService matching', () => {
  function makePrisma() {
    return {
      membership: { update: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() },
      sellerProfile: { findUnique: jest.fn() },
      patrollerProfile: { findUnique: jest.fn() },
      user: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    };
  }

  it('bumps the watermark when a match fills in a missing field', async () => {
    const prisma = makePrisma();
    prisma.user.findFirst.mockResolvedValue({
      id: 'u1', email: 'a@example.com', phone: null, nspId: null, firstName: null, lastName: null,
    });
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.update.mockResolvedValue({ id: 'u1' });

    const touch = new MembershipTouchService(asPrisma(prisma));
    const spy = jest.spyOn(touch, 'touchAllForUser').mockResolvedValue();
    await new PersonService(asPrisma(prisma), touch).resolveOrCreate({
      email: 'a@example.com',
      firstName: 'Ada',
    });

    // The roster renders firstName, so filling it in has to reach devices.
    expect(prisma.user.update).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith('u1');
  });

  it('leaves the watermark alone when nothing actually changed', async () => {
    const prisma = makePrisma();
    prisma.user.findFirst.mockResolvedValue({
      id: 'u1', email: 'a@example.com', phone: null, nspId: null, firstName: 'Ada', lastName: 'L',
    });
    prisma.user.findUnique.mockResolvedValue(null);

    const touch = new MembershipTouchService(asPrisma(prisma));
    const spy = jest.spyOn(touch, 'touchAllForUser').mockResolvedValue();
    await new PersonService(asPrisma(prisma), touch).resolveOrCreate({ email: 'a@example.com', firstName: 'Ada' });

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('matches on NSP ID ahead of contact, because it is an issued identifier', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'byNsp', email: null, phone: null, nspId: 'A100', firstName: 'Ada', lastName: 'L',
    });
    prisma.user.findFirst.mockResolvedValue({ id: 'byEmail' });

    const touch = new MembershipTouchService(asPrisma(prisma));
    const found = await new PersonService(asPrisma(prisma), touch).resolve({
      nspId: 'a-100',
      email: 'a@example.com',
    });

    expect(found?.id).toBe('byNsp');
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { nspId: 'A100' } }),
    );
  });

  it('refuses a claim on a contact someone else has already verified', async () => {
    const prisma = makePrisma();
    prisma.user.findFirst.mockResolvedValue(null);
    // No match by contact, but the verified mirror is held by another person.
    prisma.user.findUnique.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve('verifiedEmail' in where ? { id: 'someone-else' } : null),
    );

    const service = new PersonService(asPrisma(prisma), new MembershipTouchService(asPrisma(prisma)));

    await expect(service.resolveOrCreate({ email: 'taken@example.com' })).rejects.toThrow(
      /already verified by another account/,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
