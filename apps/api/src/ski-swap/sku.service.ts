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

    const swap = await this.prisma.skiSwap.findUniqueOrThrow({
      where: { id: swapId },
      select: { skuPrefix: true },
    });

    return formatSku(swap.skuPrefix, key, await this.claimCounter(swapId, key));
  }

  /**
   * Claims the next counter value for a (swap, code) pair.
   *
   * Deliberately not `prisma.upsert`, which is two statements: concurrent
   * callers all find no row and all attempt the insert, so every one but the
   * winner fails on the unique index. That is not a rare race — it is the
   * *first two items* at a station, entered seconds apart.
   *
   * `INSERT ... ON DUPLICATE KEY UPDATE` is one atomic statement, and MySQL's
   * `LAST_INSERT_ID(expr)` smuggles the value this statement assigned back out
   * on the session. The interactive transaction is what pins the connection, so
   * the read cannot land on a different one and see someone else's number.
   */
  private async claimCounter(swapId: string, code: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO SwapSkuCounter (id, swapId, code, lastCounter)
        VALUES (${createId()}, ${swapId}, ${code}, LAST_INSERT_ID(1))
        ON DUPLICATE KEY UPDATE lastCounter = LAST_INSERT_ID(lastCounter + 1)`;

      const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT LAST_INSERT_ID() AS n`;
      return Number(row.n);
    });
  }

  /**
   * Claims the next free code for an org.
   *
   * Stations are the only consumers now. Devices used to take one each — every
   * bridge burning a character it never minted a SKU with — which quietly halved
   * the pool at a venue running mixed hardware.
   *
   * Running out is a hard error at station creation rather than a silent widening
   * at print time: a two-character code would push the SKU past what the barcode
   * can carry, producing an unscannable tag nobody notices until the register.
   */
  async allocateCode(orgId: string): Promise<string> {
    const stations = await this.prisma.checkinStation.findMany({
      where: { orgId },
      select: { code: true, deletedAt: true },
    });
    const live = new Set(stations.filter((s) => !s.deletedAt).map((s) => s.code));
    const everUsed = new Set(stations.map((s) => s.code));

    // A letter never given out comes first, so a SKU goes on naming the counter
    // it was printed at for as long as the pool allows.
    for (const c of SKU_CODE_ALPHABET) {
      if (!everUsed.has(c)) return c;
    }

    // Then a retired station's letter, once no running swap has SKUs under it.
    // Nothing duplicates even then: a SKU carries its swap's prefix, and its
    // counter is per swap and letter. What's kept off-limits is the letter a
    // live swap's tags still say, so no two counters in it share one.
    const counters = await this.prisma.swapSkuCounter.findMany({
      where: { swap: { orgId, active: true }, lastCounter: { gt: 0 } },
      select: { code: true },
    });
    const inRunningSwaps = new Set(counters.map((c) => c.code));
    for (const c of SKU_CODE_ALPHABET) {
      if (!live.has(c) && !inRunningSwaps.has(c)) return c;
    }

    throw new ConflictException(
      `All ${SKU_CODE_ALPHABET.length} station codes are in use, by live stations or by retired ones whose ` +
        'tags are in a running swap. A retired station’s code frees up once the swaps it printed for have ended.',
    );
  }

}
