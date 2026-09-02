import { SkuService } from './sku.service';
import { SKU_CODE_ALPHABET, deriveSkuPrefix, formatSku, MAX_SKU_LENGTH } from './sku.util';
import type { PrismaService } from '../prisma/prisma.service';

const asPrisma = (m: unknown): PrismaService => m as PrismaService;

describe('sku.util', () => {
  it('namespaces by code when one is given', () => {
    expect(formatSku('SS26', 'A', 42)).toBe('SS26-A-0042');
  });

  it('omits the segment for server-minted SKUs', () => {
    expect(formatSku('SS26', null, 42)).toBe('SS26-0042');
    expect(formatSku('SS26', '*', 42)).toBe('SS26-0042');
  });

  // 6 prefix + 1 code + 4 counter + 2 separators is the whole barcode budget.
  it('stays inside the barcode ceiling at the widest legal prefix', () => {
    const prefix = deriveSkuPrefix('Annual Backcountry Ski Swap 2026');
    expect(prefix).toHaveLength(6);
    expect(formatSku(prefix, 'A', 9999)).toHaveLength(MAX_SKU_LENGTH);
  });

  it('excludes the glyphs that read ambiguously under a barcode', () => {
    for (const ch of 'IO01') expect(SKU_CODE_ALPHABET).not.toContain(ch);
    expect(SKU_CODE_ALPHABET).toHaveLength(32);
  });
});

describe('SkuService', () => {
  /**
   * The counter claim is raw SQL — its concurrency guarantee lives in MySQL and
   * is covered by scripts/smoke-sku-concurrency.mjs against a real database.
   * What a mock can honestly check is which code a claim is made against, so
   * that is what these capture: the interpolated parameters of the statement.
   */
  function makePrisma() {
    const claims: unknown[][] = [];
    return {
      claims,
      $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({
          $executeRaw: (_strings: TemplateStringsArray, ...params: unknown[]) => {
            claims.push(params);
            return Promise.resolve(1);
          },
          $queryRaw: () => Promise.resolve([{ n: 7n }]),
        }),
      ),
      skiSwap: { findUniqueOrThrow: jest.fn().mockResolvedValue({ skuPrefix: 'SS26' }) },
      device: { findMany: jest.fn().mockResolvedValue([]) },
      checkinStation: { findMany: jest.fn().mockResolvedValue([]) },
    };
  }

  it('increments the counter belonging to that code, not a shared one', async () => {
    const prisma = makePrisma();
    expect(await new SkuService(asPrisma(prisma)).next('swap1', 'B')).toBe('SS26-B-0007');
    // (id, swapId, code) — the pair the ON DUPLICATE KEY clause keys on.
    expect(prisma.claims[0].slice(1)).toEqual(['swap1', 'B']);
  });

  it('routes server-minted SKUs to a reserved counter that is never allocatable', async () => {
    const prisma = makePrisma();
    expect(await new SkuService(asPrisma(prisma)).next('swap1', null)).toBe('SS26-0007');
    const code = prisma.claims[0][2] as string;
    expect(SKU_CODE_ALPHABET).not.toContain(code);
  });

  /**
   * Allocation, against a stub that honours the filter it is handed.
   *
   * The previous stub answered the same rows whatever `where` it was given, so
   * it could not tell whether the service asked about every station or only the
   * live ones. It asked about only the live ones, and the difference reached a
   * venue as a 500 on the ordinary act of adding a station.
   */
  function stationsIn(rows: { code: string; deletedAt: Date | null }[]) {
    const prisma = makePrisma();
    prisma.checkinStation.findMany.mockImplementation(
      ({ where }: { where: { deletedAt?: null } }) =>
        Promise.resolve(
          rows
            .filter((r) => (where.deletedAt === null ? r.deletedAt === null : true))
            .map((r) => ({ code: r.code })),
        ),
    );
    return prisma;
  }

  // Stations are the only consumers now. Devices used to take one each, which
  // meant a bridge burned a character it never minted a SKU with.
  it('allocates the first code no station holds', async () => {
    const prisma = stationsIn([
      { code: 'A', deletedAt: null },
      { code: 'B', deletedAt: null },
    ]);
    expect(await new SkuService(asPrisma(prisma)).allocateCode('org1')).toBe('C');
  });

  it('does not hand out a retired station\'s code', async () => {
    // The unique index counts tombstones, so reusing one is a constraint
    // violation — and a retired code has to stay retired anyway, or a SKU
    // printed at the old station A would name the new one.
    const prisma = stationsIn([
      { code: 'A', deletedAt: new Date('2026-01-01') },
      { code: 'B', deletedAt: null },
    ]);
    expect(await new SkuService(asPrisma(prisma)).allocateCode('org1')).toBe('C');
  });

  it('counts a retired code against the pool', async () => {
    const prisma = stationsIn(
      [...SKU_CODE_ALPHABET].map((c) => ({ code: c, deletedAt: new Date('2026-01-01') })),
    );
    await expect(new SkuService(asPrisma(prisma)).allocateCode('org1')).rejects.toThrow(
      /used all/,
    );
  });

  it('does not tell someone to retire a station to free a code', async () => {
    // Retiring frees nothing, so that advice is a loop with no exit.
    const prisma = stationsIn(
      [...SKU_CODE_ALPHABET].map((c) => ({ code: c, deletedAt: null })),
    );
    await expect(new SkuService(asPrisma(prisma)).allocateCode('org1')).rejects.not.toThrow(
      /retire a station before/i,
    );
  });
});
