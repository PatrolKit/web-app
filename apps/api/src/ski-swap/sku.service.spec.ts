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
  function makePrisma() {
    return {
      swapSkuCounter: { upsert: jest.fn().mockResolvedValue({ lastCounter: 7 }) },
      skiSwap: { findUniqueOrThrow: jest.fn().mockResolvedValue({ skuPrefix: 'SS26' }) },
      device: { findMany: jest.fn().mockResolvedValue([]) },
      checkinStation: { findMany: jest.fn().mockResolvedValue([]) },
    };
  }

  it('increments the counter belonging to that code, not a shared one', async () => {
    const prisma = makePrisma();
    expect(await new SkuService(asPrisma(prisma)).next('swap1', 'B')).toBe('SS26-B-0007');
    expect(prisma.swapSkuCounter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { swapId_code: { swapId: 'swap1', code: 'B' } } }),
    );
  });

  it('routes server-minted SKUs to a reserved counter that is never allocatable', async () => {
    const prisma = makePrisma();
    expect(await new SkuService(asPrisma(prisma)).next('swap1', null)).toBe('SS26-0007');
    const { where } = prisma.swapSkuCounter.upsert.mock.calls[0][0];
    expect(SKU_CODE_ALPHABET).not.toContain(where.swapId_code.code);
  });

  it('allocates the first free code across stations and devices alike', async () => {
    const prisma = makePrisma();
    prisma.device.findMany.mockResolvedValue([{ skiSwapDeviceCode: 'A' }]);
    prisma.checkinStation.findMany.mockResolvedValue([{ code: 'B' }]);
    expect(await new SkuService(asPrisma(prisma)).allocateCode('org1')).toBe('C');
  });

  it('fails loudly when the pool is exhausted rather than widening the code', async () => {
    const prisma = makePrisma();
    prisma.device.findMany.mockResolvedValue(
      [...SKU_CODE_ALPHABET].map((c) => ({ skiSwapDeviceCode: c })),
    );
    await expect(new SkuService(asPrisma(prisma)).allocateCode('org1')).rejects.toThrow(/in use/);
  });
});
