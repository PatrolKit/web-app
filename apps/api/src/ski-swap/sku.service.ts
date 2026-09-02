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
    // Every row, including retired ones. A retired station keeps its code on
    // purpose — a SKU printed at station A has to go on meaning station A
    // forever, so the letter can never be handed to a different counter — and
    // the unique index counts tombstones whether or not this query does.
    // Filtering them out here handed back a letter the database already held,
    // and the create failed with a raw constraint violation: a 500 for the
    // ordinary act of adding a station to an org that had ever retired one.
    const stations = await this.prisma.checkinStation.findMany({
      where: { orgId },
      select: { code: true },
    });

    const taken = new Set<string>(stations.map((s) => s.code));

    for (const c of SKU_CODE_ALPHABET) {
      if (!taken.has(c)) return c;
    }

    // Retiring frees nothing, so saying "retire one" would send someone round
    // a loop that cannot end.
    throw new ConflictException(
      `This organisation has used all ${SKU_CODE_ALPHABET.length} station codes. ` +
        'A code is never reused, even after a station is retired, so that a SKU always ' +
        'names the counter it was printed at.',
    );
  }
}
