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

  // Stations are the only consumers now. Devices used to take one each, which
  // meant a bridge burned a character it never minted a SKU with.
  it('allocates the first code no live station holds', async () => {
    const prisma = makePrisma();
    prisma.checkinStation.findMany.mockResolvedValue([{ code: 'A' }, { code: 'B' }]);
    expect(await new SkuService(asPrisma(prisma)).allocateCode('org1')).toBe('C');
  });

  it('fails loudly when the pool is exhausted rather than widening the code', async () => {
    const prisma = makePrisma();
    prisma.checkinStation.findMany.mockResolvedValue(
      [...SKU_CODE_ALPHABET].map((c) => ({ code: c })),
    );
    await expect(new SkuService(asPrisma(prisma)).allocateCode('org1')).rejects.toThrow(/in use/);
  });
});
