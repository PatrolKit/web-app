import { Injectable, Logger } from '@nestjs/common';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { PayPalClient, type PayoutBatchResult, type PayoutItemRequest } from './paypal.client';
import {
  PosAdapterFactory, type IPosAdapter, type PosCatalogItem, type PosItemSync, type PosSaleLine, type PosUpsertResult,
} from '../pos/pos.adapter';

/**
 * Test doubles for the two things a payout run reaches outside itself: Square's
 * completed orders, and PayPal (Plan 25 §14).
 *
 * Wired only when `PAYOUTS_STUB=1`, and the app refuses to start with that set
 * in production. They exist so `smoke-payouts.mjs` can prove the parts that
 * cannot be proved any other way — that pressing send twice sends one batch,
 * that an unverified webhook changes nothing — by counting what actually
 * arrives here rather than by reading a status back out of our own database.
 *
 * Nothing in this file may be imported by anything but the module wiring.
 */

/** Every call recorded, one JSON object per line, for a script to count. */
function record(event: Record<string, unknown>) {
  const path = process.env.PAYPAL_STUB_LOG;
  if (!path) return;
  appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}

@Injectable()
export class StubPayPalClient extends PayPalClient {
  private readonly logger = new Logger(StubPayPalClient.name);
  /** sender_batch_id → what was accepted under it. */
  private readonly batches = new Map<string, PayoutBatchResult>();

  async createBatch(
    orgId: string,
    senderBatchId: string,
    items: PayoutItemRequest[],
  ): Promise<PayoutBatchResult> {
    record({ call: 'createBatch', orgId, senderBatchId, items });

    // PayPal dedupes a `sender_batch_id` for thirty days and hands back the
    // batch it already has. Reproduced exactly, because it is the mechanism the
    // send path relies on to make a retry safe — a stub that quietly accepted
    // the same batch twice would let a real double payment pass the smoke.
    const seen = this.batches.get(senderBatchId);
    if (seen) {
      record({ call: 'createBatch.deduped', senderBatchId });
      this.logger.warn({ senderBatchId }, 'Stub: duplicate sender_batch_id, returning the first batch');
      return seen;
    }

    const result: PayoutBatchResult = {
      batchId: `stub-batch-${senderBatchId}`,
      batchStatus: 'PENDING',
      items: items.map((item, i) => ({
        senderItemId: item.senderItemId,
        payoutItemId: `stub-item-${senderBatchId}-${i}`,
        // PENDING, not SUCCESS. A real batch is accepted before it is paid, and
        // a stub that answered SUCCESS at creation would hide every bug in the
        // webhook and sweep paths behind an instant happy ending.
        transactionStatus: 'PENDING',
      })),
    };
    this.batches.set(senderBatchId, result);
    return result;
  }

  async getBatch(orgId: string, batchId: string): Promise<PayoutBatchResult> {
    record({ call: 'getBatch', orgId, batchId });
    const found = [...this.batches.values()].find((b) => b.batchId === batchId);
    if (!found) return { batchId, batchStatus: 'DENIED', items: [] };

    // Settled by the time anybody asks again: this is the sweep's job, and the
    // script asserts a line can leave SENDING this way as well as by webhook.
    return {
      ...found,
      batchStatus: 'SUCCESS',
      items: found.items.map((i) => ({ ...i, transactionStatus: 'SUCCESS' })),
    };
  }

  async cancelItem(orgId: string, payoutItemId: string): Promise<void> {
    record({ call: 'cancelItem', orgId, payoutItemId });
  }

  /**
   * Accepts a delivery only when it carries the agreed signature.
   *
   * The point of the stub is not to check a signature but to have one that can
   * be got wrong, so the script can aim a forged event at a line and watch
   * nothing happen.
   */
  async verifyWebhook(orgId: string, headers: Record<string, string>): Promise<boolean> {
    const expected = process.env.PAYPAL_STUB_SIG ?? 'stub-signature';
    const ok = headers['paypal-transmission-sig'] === expected;
    record({ call: 'verifyWebhook', orgId, verified: ok });
    return ok;
  }

  forget(): void {
    // Nothing held: the stub has no tokens.
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    return { success: true, message: 'Stub PayPal client — nothing was contacted' };
  }
}

/**
 * Square's completed orders, read from a file the script wrote.
 *
 * Only `listSales` answers. Everything else throws rather than returning
 * something plausible: a stub that silently pretended to sync an item would
 * make a failing smoke look like a passing one.
 */
@Injectable()
export class StubPosAdapterFactory extends PosAdapterFactory {
  async forOrg(): Promise<IPosAdapter | null> {
    return new StubPosAdapter();
  }
}

class StubPosAdapter implements IPosAdapter {
  async listSales(locationId: string, from: Date, to: Date): Promise<PosSaleLine[]> {
    const path = process.env.SMOKE_SALES_FILE;
    if (!path) return [];
    const rows = JSON.parse(readFileSync(path, 'utf8')) as (Omit<PosSaleLine, 'soldAt'> & {
      soldAt: string;
    })[];
    return rows
      .map((r) => ({ ...r, soldAt: new Date(r.soldAt) }))
      // The window is honoured, so a script can prove a sale outside it is
      // excluded rather than taking it on trust.
      .filter((r) => r.soldAt >= from && r.soldAt <= to);
  }

  // ─── A catalog in a file, for the swap diagnostics (Plan 41) ───────────────
  //
  // `SMOKE_CATALOG_FILE` is the catalog: read on every call and written back,
  // so a smoke script can change "Square" between runs as staff would by hand.

  private catalog(): (PosCatalogItem & { categoryId: string })[] {
    const path = process.env.SMOKE_CATALOG_FILE;
    if (!path) this.refuse();
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  }

  private saveCatalog(rows: (PosCatalogItem & { categoryId: string })[]): void {
    writeFileSync(process.env.SMOKE_CATALOG_FILE!, JSON.stringify(rows, null, 2));
  }

  async listCategoryItems(categoryId: string, onPage?: (soFar: number) => void): Promise<PosCatalogItem[]> {
    const rows = this.catalog().filter((r) => r.categoryId === categoryId);
    onPage?.(rows.length);
    return rows;
  }

  async itemsBySku(categoryId: string, skus: string[]): Promise<PosCatalogItem[]> {
    return this.catalog().filter((r) => r.categoryId === categoryId && skus.includes(r.sku));
  }

  async upsertItems(items: PosItemSync[]): Promise<{ results: PosUpsertResult[]; resolvedCategoryId: string }> {
    const rows = this.catalog();
    const results = items.map((item): PosUpsertResult => {
      const row: PosCatalogItem & { categoryId: string } = {
        itemId: '', variationId: '', version: '1', updatedAt: new Date().toISOString(),
        sku: item.sku,
        name: item.name,
        description: item.description?.trim() || null,
        pricing: item.priceCents === null ? { type: 'variable' } : { type: 'fixed', cents: item.priceCents },
        categoryId: item.categoryId,
      };
      const at = item.posItemId ? rows.findIndex((r) => r.itemId === item.posItemId) : -1;
      if (at >= 0) {
        rows[at] = { ...row, itemId: rows[at].itemId, variationId: rows[at].variationId, version: String(Number(rows[at].version ?? 0) + 1) };
      } else {
        const n = rows.length + 1;
        rows.push({ ...row, itemId: `stub-item-${Date.now().toString(36)}-${n}`, variationId: `stub-var-${Date.now().toString(36)}-${n}` });
      }
      const saved = at >= 0 ? rows[at] : rows[rows.length - 1];
      return { posItemId: saved.itemId, posVariationId: saved.variationId };
    });
    this.saveCatalog(rows);
    return { results, resolvedCategoryId: items[0]?.categoryId ?? '' };
  }

  async deleteItems(posItemIds: string[]): Promise<void> {
    this.saveCatalog(this.catalog().filter((r) => !posItemIds.includes(r.itemId)));
  }

  private refuse(): never {
    throw new Error('The stub POS adapter only answers listSales, and the catalog calls with SMOKE_CATALOG_FILE set');
  }

  upsertCategory(): Promise<string> { this.refuse(); }
  syncItem(): never { this.refuse(); }
  deleteItem(): never { this.refuse(); }
  syncNewItems(): never { this.refuse(); }
  uploadImage(): never { this.refuse(); }
  deleteImage(): never { this.refuse(); }
  /** No stock in the stub's catalog: an empty answer, which reads as unknown rather than failing a write. */
  async getInventoryCounts(): Promise<Map<string, number>> {
    if (!process.env.SMOKE_CATALOG_FILE) this.refuse();
    return new Map();
  }
  setInitialInventory(): never { this.refuse(); }
  setInventoryPhysicalCount(): never { this.refuse(); }
}

/** Whether this process is running with the test doubles in place. */
export function payoutStubsEnabled(): boolean {
  if (process.env.PAYOUTS_STUB !== '1') return false;
  if (process.env.NODE_ENV === 'production') {
    // Loud and fatal. A production box that stubbed PayPal would report every
    // payout as sent and send none of them.
    throw new Error('PAYOUTS_STUB must never be set in production');
  }
  return true;
}
