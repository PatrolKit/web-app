import { SellerService, toSellerResponse } from './seller.service';

/**
 * What an offline client can learn from `GET sellers`.
 *
 * A device holding a local mirror asks "what changed since", and two things had
 * to be true for the answer to be usable: the watermark it filters on has to be
 * the one that actually moves when a seller is edited, and a removal has to
 * arrive as a row rather than as an absence. Neither was, and both failures are
 * silent — the endpoint returns 200 and a short list either way.
 *
 * Against a stub rather than a database: what is being tested is the query the
 * service *asks for*. A test that ran it would prove the rows came back, not
 * that the right clock was read.
 */

/** The row shape `toSellerResponse` reads, without exporting the type to get it. */
type SellerRow = Parameters<typeof toSellerResponse>[0];

/** Only the parts of a Prisma `where` these tests read back. */
type Where = {
  deletedAt?: null;
  /** Declared so a test can assert it is *not* set — this was the old, wrong place. */
  updatedAt?: { gt: Date };
  membership: { deletedAt?: null; updatedAt?: { gt: Date } };
};

/** Records the `where` it was handed, and returns whatever rows it was given. */
function stubPrisma(rows: SellerRow[] = []) {
  const wheres: Where[] = [];
  return {
    wheres,
    sellerProfile: {
      findMany: async ({ where }: { where: Where }) => {
        wheres.push(where);
        return rows;
      },
    },
    // Which active swaps each seller has items in, for the receipt button.
    swapItem: { findMany: async () => [] },
  };
}

/** `list` reaches for prisma alone; the other three collaborators stay unbuilt. */
function service(prisma: ReturnType<typeof stubPrisma>) {
  const unused = {} as never;
  return new SellerService(prisma as unknown as never, unused, unused, unused, { enabled: async () => true } as never);
}

/** A seller row shaped the way SELLER_INCLUDE returns one. */
function row(over: {
  id?: string;
  deletedAt?: Date | null;
  membershipDeletedAt?: Date | null;
  updatedAt?: Date;
  user?: Record<string, unknown>;
} = {}): SellerRow {
  return {
    id: over.id ?? 'seller-1',
    businessName: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: over.deletedAt ?? null,
    membership: {
      orgId: 'org-1',
      userId: 'user-1',
      updatedAt: over.updatedAt ?? new Date('2026-08-31T12:00:00.000Z'),
      deletedAt: over.membershipDeletedAt ?? null,
      user: {
        firstName: 'Dana', lastName: 'Reyes',
        email: null, phone: '+15550199001',
        street: '12 Elm Street', city: 'Burlington', state: 'VT', zip: '05401',
        emailVerifiedAt: null, phoneVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        // Verified by phone and not by email, so a receipt would go by text.
        verifiedEmail: null, verifiedPhone: '+15550199001',
        payoutMethod: 'CHECK', payoutTarget: null, payoutHandle: null,
        ...over.user,
      },
    },
  };
}

describe('the watermark the seller list filters on', () => {
  it('is the membership’s, not the seller profile’s', async () => {
    const prisma = stubPrisma();
    await service(prisma).list('org-1', undefined, '2026-08-30T00:00:00.000Z');

    const where = prisma.wheres[0];
    // Almost nothing a client reads lives on the profile row. Filtering on its
    // timestamp meant a rename, a corrected phone number or a new payout never
    // reached a device — the edit bumped the membership and nothing else.
    expect(where.membership.updatedAt).toEqual({ gt: new Date('2026-08-30T00:00:00.000Z') });
    expect(where.updatedAt).toBeUndefined();
  });

  it('is not applied at all when no cursor is given', async () => {
    const prisma = stubPrisma();
    await service(prisma).list('org-1');

    expect(prisma.wheres[0].membership.updatedAt).toBeUndefined();
  });

  it('is read the same way by a business-name search', async () => {
    const prisma = stubPrisma();
    await service(prisma).list('org-1', 'Summit', '2026-08-30T00:00:00.000Z');

    // Two queries, one union. A cursor that applied to only one of them would
    // return the other's rows on every poll, forever.
    expect(prisma.wheres).toHaveLength(2);
    for (const where of prisma.wheres) {
      expect(where.membership.updatedAt).toEqual({ gt: new Date('2026-08-30T00:00:00.000Z') });
    }
  });
});

describe('tombstones', () => {
  it('are withheld from a caller with no cursor', async () => {
    const prisma = stubPrisma();
    await service(prisma).list('org-1');

    // This endpoint backs the staff Sellers page directly, and a removed seller
    // has no business on it.
    expect(prisma.wheres[0].deletedAt).toBeNull();
    expect(prisma.wheres[0].membership.deletedAt).toBeNull();
  });

  it('are returned to a caller asking what changed', async () => {
    const prisma = stubPrisma();
    await service(prisma).list('org-1', undefined, '2026-08-30T00:00:00.000Z');

    // Soft removal exists so an offline device can learn about it, which it
    // cannot do from a list that simply stops mentioning the row.
    expect(prisma.wheres[0].deletedAt).toBeUndefined();
    expect(prisma.wheres[0].membership.deletedAt).toBeUndefined();
  });

  it('are withheld from a business-name search with no cursor', async () => {
    const prisma = stubPrisma();
    await service(prisma).list('org-1', 'Summit');

    for (const where of prisma.wheres) {
      expect(where.deletedAt).toBeNull();
      expect(where.membership.deletedAt).toBeNull();
    }
  });

  it('never count towards the sellers who cannot be paid', async () => {
    // Removed, and missing an address — that is not someone to chase.
    const prisma = stubPrisma([
      row({ deletedAt: new Date('2026-08-30T00:00:00.000Z'), user: { street: null, city: null, state: null, zip: null } }),
    ]);
    const found = await service(prisma).list('org-1', undefined, '2026-08-30T00:00:00.000Z', true);

    expect(found.sellers).toHaveLength(0);
  });
});

describe('what a seller row reports', () => {
  it('carries the membership watermark as its updatedAt', () => {
    const mapped = toSellerResponse(row({ updatedAt: new Date('2026-08-31T12:00:00.000Z') }), true);

    // The value a client stores as its cursor and the value the server filters
    // on have to be the same clock, or the cursor walks past its own updates.
    expect(mapped.updatedAt).toBe('2026-08-31T12:00:00.000Z');
  });

  it('reports a seller removed from the swap', () => {
    const mapped = toSellerResponse(row({ deletedAt: new Date('2026-08-30T09:00:00.000Z') }), true);
    expect(mapped.deletedAt).toBe('2026-08-30T09:00:00.000Z');
  });

  it('reports a seller who left the org', () => {
    // The profile is untouched in this case; the membership is what was ended.
    const mapped = toSellerResponse(row({ membershipDeletedAt: new Date('2026-08-30T09:00:00.000Z') }), true);
    expect(mapped.deletedAt).toBe('2026-08-30T09:00:00.000Z');
  });

  it('says nothing about removal for a seller still here', () => {
    expect(toSellerResponse(row(), true).deletedAt).toBeNull();
  });
});

describe('receiptChannel and the texting switch (Plan 29)', () => {
  it('is never SMS while texting is off', () => {
    const phoneOnly = row();
    phoneOnly.membership.user.verifiedEmail = null;
    phoneOnly.membership.user.verifiedPhone = '+18025550100';
    expect(toSellerResponse(phoneOnly, true).receiptChannel).toBe('SMS');
    expect(toSellerResponse(phoneOnly, false).receiptChannel).toBeNull();
  });
});
