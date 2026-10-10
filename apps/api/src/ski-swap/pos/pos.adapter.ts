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
  /**
   * The catalog variation, which is `SwapItem.squareVariationId`. Empty for a
   * custom amount typed at the register, which has none (Plan 48).
   */
  variationId: string;
  /**
   * The line within its order (Square's line `uid`): with `orderId`, what a
   * Sales check decision is keyed on (Plan 48 D4).
   */
  lineUid?: string;
  /** The line's name as rung up, e.g. "Swap Item 73338" or "Custom Amount". */
  name?: string | null;
  /** The order's payment, for a link to the sale in Square. */
  paymentId?: string | null;
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
  /** The item's categories (Plan 48 D11). */
  categoryIds?: string[];
  /** Archived in Square: hidden from the item list, but still scanned (Plan 48). */
  archived?: boolean;
}

/** What a sale was rung up on (Plan 48): a variation and its item, archived or not. */
export interface PosVariationInfo {
  variationId: string;
  itemId: string;
  itemName: string;
  variationName: string | null;
  sku: string;
  categoryIds: string[];
  archived: boolean;
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
  /** Variations whose stock changed at the location since then (Catalog check's stock: a sale still landing). */
  stockChangedSince(variationIds: string[], locationId: string, since: Date): Promise<Set<string>>;
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
  /**
   * What these variations are (Plan 48): each with its item, archived ones
   * included. One Square can't find is absent.
   */
  describeVariations(variationIds: string[]): Promise<Map<string, PosVariationInfo>>;
  /** Category names by id (Plan 48). */
  listCategories(): Promise<Map<string, string>>;
  /** One order line, re-read before a Sales check decision (Plan 48 D13). Null when it's gone. */
  getSaleLine(orderId: string, lineUid: string): Promise<PosSaleLine | null>;
  /**
   * Every item carrying these SKUs anywhere in the catalogue, archived ones
   * included (Plan 48 D11): what a scan can find, wherever it is filed.
   */
  itemsBySkuAnywhere(skus: string[]): Promise<PosCatalogItem[]>;
  /** Prefixes each of an item's variation SKUs, e.g. "2025-73789" (Plan 48 D11). */
  renumberItemSkus(posItemId: string, prefix: string): Promise<void>;
}

/** Factory that builds an org-scoped adapter, returning null when POS is not configured. */
export abstract class PosAdapterFactory {
  abstract forOrg(orgId: string): Promise<IPosAdapter | null>;
}
