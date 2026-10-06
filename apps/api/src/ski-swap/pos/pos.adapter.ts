export interface PosItemSync {
  posItemId?: string;
  posVariationId?: string;
  name: string;
  description?: string;
  /** Null for a ticket not yet priced: sold at a price the clerk types. */
  priceCents: number | null;
  sku: string;
  categoryId: string;
  categoryName: string;
}

/**
 * One line of one order: something that actually sold, at a time, for an amount.
 *
 * The distinction that matters for a payout (Plan 25 §2): inventory going down
 * is not a sale, because a volunteer correcting a count looks identical. A line
 * here came from a transaction and can be pointed at.
 */
export interface PosSaleLine {
  orderId: string;
  /** The catalog variation, which is `SwapItem.squareVariationId`. */
  variationId: string;
  quantity: number;
  /** What the register actually took for this line, after any discount. */
  collectedCents: number;
  /**
   * One unit's price as rung up, before discounts: Square's `basePriceMoney`.
   * For a variable-priced item that is what the clerk typed (Plan 32). Null
   * when Square didn't say.
   */
  unitPriceCents: number | null;
  /** How much of `quantity` came back. */
  refundedQuantity: number;
  soldAt: Date;
}

/**
 * One catalog item as Square holds it, flattened to what the swap diagnostics
 * compare (Plan 41): one entry per variation, keyed by its SKU.
 */
export interface PosCatalogItem {
  itemId: string;
  variationId: string;
  sku: string;
  name: string;
  /** The item's description: our notes. Null when it has none. */
  description: string | null;
  pricing: { type: 'fixed'; cents: number } | { type: 'variable' };
  /** The item's version, as a string so it survives JSON. */
  version: string | null;
  /** When Square last changed it. Square keeps no creation time. */
  updatedAt: string | null;
}

/** One item's outcome in a bulk write: its ids, or Square's reason. */
export type PosUpsertResult = { posItemId: string; posVariationId: string } | { error: string };

/** Org-scoped POS adapter — all methods operate against one org's credentials. */
export interface IPosAdapter {
  /** Creates or recreates a POS category and returns its ID. */
  upsertCategory(name: string): Promise<string>;
  syncItem(item: PosItemSync, locationId: string, initialQuantity: number): Promise<{ posItemId: string; posVariationId: string; resolvedCategoryId: string }>;
  deleteItem(posItemId: string): Promise<void>;
  /**
   * Creates many new items at once (Plan 38): a block of issued tickets. Each
   * gets `initialQuantity` in stock. Answers each item's ids in input order,
   * and the category used, which differs when it had to be recreated.
   */
  syncNewItems(items: PosItemSync[], locationId: string, initialQuantity: number): Promise<{
    ids: { posItemId: string; posVariationId: string }[];
    resolvedCategoryId: string;
  }>;
  /** Deletes many items at once (Plan 38): returned tickets. */
  deleteItems(posItemIds: string[]): Promise<void>;
  uploadImage(posItemId: string, buffer: Buffer, mimeType: string): Promise<{ posImageId: string; imageUrl: string }>;
  deleteImage(posImageId: string): Promise<void>;
  getInventoryCounts(variationIds: string[], locationId: string): Promise<Map<string, number>>;
  setInitialInventory(variationId: string, locationId: string, quantity: number): Promise<void>;
  setInventoryPhysicalCount(variationId: string, locationId: string, quantity: number): Promise<void>;
  /**
   * Completed sales in a window, one entry per order line.
   *
   * Paginates to the end: a partial read would silently underpay whoever fell
   * off the last page.
   */
  listSales(locationId: string, from: Date, to: Date): Promise<PosSaleLine[]>;
  /**
   * Every item in a category (Plan 41), paged to the end. `onPage` hears the
   * running count, for a progress line.
   */
  listCategoryItems(categoryId: string, onPage?: (soFar: number) => void): Promise<PosCatalogItem[]>;
  /** The category's items with these SKUs (Plan 41): one SKU's current state, re-read. */
  itemsBySku(categoryId: string, skus: string[]): Promise<PosCatalogItem[]>;
  /**
   * Writes many items at once (Plan 41): existing ones (with `posItemId`) at a
   * fresh version, new ones created with `initialQuantity` in stock. Answers
   * per item in input order; a batch Square refuses is reported on its items
   * and the others stand.
   */
  upsertItems(items: PosItemSync[], locationId: string, initialQuantity: number): Promise<{
    results: PosUpsertResult[];
    resolvedCategoryId: string;
  }>;
}

/** Factory that builds an org-scoped adapter, returning null when POS is not configured. */
export abstract class PosAdapterFactory {
  abstract forOrg(orgId: string): Promise<IPosAdapter | null>;
}
