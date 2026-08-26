import { ConflictException, Injectable } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { SERVER_SKU_CODE, SKU_CODE_ALPHABET, formatSku } from './sku.util';

/**
 * Mints SKUs, and allocates the single-character codes that namespace them.
 *
 * Counters are per (swap, code) rather than per swap, so simultaneous check-ins
 * at different stations never touch the same row. That matters because
 * self-service makes concurrent item creation the normal case, where staff entry
 * was always serial — and a duplicate SKU is a duplicate barcode, which sells
 * the wrong item at the register.
 */
@Injectable()
export class SkuService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Next SKU for a swap, from the counter belonging to `code`. Pass null for
   * server-minted items, which keeps today's un-namespaced format.
   */
  async next(swapId: string, code: string | null): Promise<string> {
    const key = code ?? SERVER_SKU_CODE;

    // Upsert-then-increment in one statement: the unique index on
    // (swapId, code) is what serialises two stations racing on their first item.
    const counter = await this.prisma.swapSkuCounter.upsert({
      where: { swapId_code: { swapId, code: key } },
      update: { lastCounter: { increment: 1 } },
      create: { id: createId(), swapId, code: key, lastCounter: 1 },
      select: { lastCounter: true },
    });

    const swap = await this.prisma.skiSwap.findUniqueOrThrow({
      where: { id: swapId },
      select: { skuPrefix: true },
    });

    return formatSku(swap.skuPrefix, key, counter.lastCounter);
  }

  /**
   * Claims the next free code for an org. Stations and devices share the pool,
   * so this checks both.
   *
   * Running out is a hard error at provisioning rather than a silent widening at
   * print time: a two-character code would push the SKU past what the barcode
   * can carry, producing an unscannable tag nobody notices until the register.
   */
  async allocateCode(orgId: string): Promise<string> {
    const [devices, stations] = await Promise.all([
      this.prisma.device.findMany({
        where: { orgId, skiSwapDeviceCode: { not: null } },
        select: { skiSwapDeviceCode: true },
      }),
      this.prisma.checkinStation.findMany({
        where: { orgId, deletedAt: null },
        select: { code: true },
      }),
    ]);

    const taken = new Set<string>([
      ...devices.map((d) => d.skiSwapDeviceCode!),
      ...stations.map((s) => s.code),
    ]);

    for (const c of SKU_CODE_ALPHABET) {
      if (!taken.has(c)) return c;
    }

    throw new ConflictException(
      `All ${SKU_CODE_ALPHABET.length} ski-swap codes are in use in this organisation. ` +
        'Remove a station or device before provisioning another.',
    );
  }
}
