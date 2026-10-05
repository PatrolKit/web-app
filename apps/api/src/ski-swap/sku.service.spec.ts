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
  function stationsIn(
    rows: { code: string; deletedAt: Date | null }[],
    /** Letters with SKUs in a running swap. */
    inRunningSwaps: string[] = [],
  ) {
    const prisma = makePrisma();
    prisma.checkinStation.findMany.mockImplementation(
      ({ where }: { where: { deletedAt?: null } }) =>
        Promise.resolve(
          rows
            .filter((r) => (where.deletedAt === null ? r.deletedAt === null : true))
            .map((r) => ({ code: r.code, deletedAt: r.deletedAt })),
        ),
    );
    (prisma as unknown as { swapSkuCounter: unknown }).swapSkuCounter = {
      findMany: jest.fn().mockImplementation(({ where }: { where: { swap: { active: boolean }; lastCounter: { gt: number } } }) => {
        expect(where).toMatchObject({ swap: { orgId: 'org1', active: true }, lastCounter: { gt: 0 } });
        return Promise.resolve(inRunningSwaps.map((code) => ({ code })));
      }),
    };
    return prisma;
  }

  const retired = new Date('2026-01-01');

  // Stations are the only consumers now. Devices used to take one each, which
  // meant a bridge burned a character it never minted a SKU with.
  it('allocates the first code no station holds', async () => {
    const prisma = stationsIn([
      { code: 'A', deletedAt: null },
      { code: 'B', deletedAt: null },
    ]);
    expect(await new SkuService(asPrisma(prisma)).allocateCode('org1')).toBe('C');
  });

  it('gives out a never-used letter before a retired one', async () => {
    // A SKU goes on naming the counter it was printed at for as long as the
    // pool allows.
    const prisma = stationsIn([
      { code: 'A', deletedAt: retired },
      { code: 'B', deletedAt: null },
    ]);
    expect(await new SkuService(asPrisma(prisma)).allocateCode('org1')).toBe('C');
  });

  it('reuses a retired station’s letter once no running swap has tags under it', async () => {
    const all = [...SKU_CODE_ALPHABET];
    const prisma = stationsIn([
      ...all.slice(0, 2).map((c) => ({ code: c, deletedAt: retired })),
      ...all.slice(2).map((c) => ({ code: c, deletedAt: null })),
    ], ['A']);
    // A is retired but still in a running swap's tags; B is free.
    expect(await new SkuService(asPrisma(prisma)).allocateCode('org1')).toBe('B');
  });

  it('never gives out a live station’s letter, whatever the swaps say', async () => {
    const all = [...SKU_CODE_ALPHABET];
    const prisma = stationsIn([
      { code: all[0], deletedAt: retired },
      ...all.slice(1).map((c) => ({ code: c, deletedAt: null })),
    ], ['A']);
    await expect(new SkuService(asPrisma(prisma)).allocateCode('org1')).rejects.toThrow(/in use/);
  });

  it('says when a retired letter frees up, when there are none left', async () => {
    const prisma = stationsIn(
      [...SKU_CODE_ALPHABET].map((c) => ({ code: c, deletedAt: retired })),
      [...SKU_CODE_ALPHABET],
    );
    await expect(new SkuService(asPrisma(prisma)).allocateCode('org1')).rejects.toThrow(
      /frees up once the swaps it printed for have ended/,
    );
  });
});
