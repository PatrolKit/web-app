import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ItemService } from './item.service';

/**
 * What happens when a bridge reads a tag.
 *
 * A scan accepts the item onto the floor — the same act as a staff member
 * tapping it on the iPad, and the same method underneath, so there is one place
 * where an item becomes sellable.
 *
 * It is only ever *doing* anything at an organisation that requires the
 * acceptance scan. That is not a check here: Plan 16 reads the setting once, at
 * check-in, and answers it onto the row, so an item is unconsigned only if the
 * setting was on when it arrived. Consigning is idempotent, so a scan at an
 * organisation that does not use acceptance finds the item already consigned
 * and changes nothing.
 *
 * The one case where that differs from reading the setting now: an item checked
 * in while the scan was required, at an organisation that has since turned it
 * off. Plan 16 D1 is explicit that those stay waiting and that scanning is how
 * staff clear them — so the row, not the current setting, is the right thing to
 * obey.
 */
@Injectable()
export class ScanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemService,
  ) {}

  /**
   * Accepts the item carrying this tag.
   *
   * Idempotent, because the firmware queues and retries: a scan whose response
   * was lost is re-sent, and re-accepting an accepted item is a no-op rather
   * than an error. `consign` already guarantees that.
   */
  async submit(
    orgId: string,
    deviceId: string,
    sku: string,
  ): Promise<{ itemId: string; sku: string; consignedAt: string }> {
    const tag = sku.trim();

    /**
     * Across the organisation's running swaps, because a station is not tied to
     * one — it survives from swap to swap, and the tag in somebody's hand does
     * not say which swap it belongs to.
     */
    const matches = await this.prisma.swapItem.findMany({
      where: { orgId, sku: tag, swap: { active: true } },
      select: { id: true, swapId: true },
    });

    if (matches.length === 0) {
      throw new NotFoundException(`No item in a running swap has tag ${tag}.`);
    }
    if (matches.length > 1) {
      // Only reachable with two running swaps whose numbers overlap, which bare
      // legacy tickets make possible. Refusing beats consigning a coin-flip.
      throw new ConflictException(
        `Tag ${tag} is on items in more than one running swap. Close one first.`,
      );
    }

    const item = await this.items.consign(orgId, matches[0].swapId, matches[0].id, deviceId);
    return { itemId: item.id, sku: item.sku, consignedAt: item.consignedAt! };
  }
}
