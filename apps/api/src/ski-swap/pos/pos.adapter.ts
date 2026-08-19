export interface PosItemSync {
  posItemId?: string;
  posVariationId?: string;
  name: string;
  description?: string;
  priceCents: number;
  sku: string;
  categoryId: string;
  categoryName: string;
}

/** Org-scoped POS adapter — all methods operate against one org's credentials. */
export interface IPosAdapter {
  /** Creates or recreates a POS category and returns its ID. */
  upsertCategory(name: string): Promise<string>;
  syncItem(item: PosItemSync, locationId: string, initialQuantity: number): Promise<{ posItemId: string; posVariationId: string; resolvedCategoryId: string }>;
  deleteItem(posItemId: string): Promise<void>;
  uploadImage(posItemId: string, buffer: Buffer, mimeType: string): Promise<{ posImageId: string; imageUrl: string }>;
  deleteImage(posImageId: string): Promise<void>;
  getInventoryCounts(variationIds: string[], locationId: string): Promise<Map<string, number>>;
  setInitialInventory(variationId: string, locationId: string, quantity: number): Promise<void>;
  setInventoryPhysicalCount(variationId: string, locationId: string, quantity: number): Promise<void>;
}

/** Factory that builds an org-scoped adapter, returning null when POS is not configured. */
export abstract class PosAdapterFactory {
  abstract forOrg(orgId: string): Promise<IPosAdapter | null>;
}
