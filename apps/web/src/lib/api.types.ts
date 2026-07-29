// Shared types used by the web API client
// These mirror the API contract shapes (source of truth is apps/api/src/contracts/)

export interface MembershipSummary {
  orgId: string;
  orgName: string;
  orgSlug: string;
  status: string;
  permissions: string[];
}

export interface MeResponse {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  memberships: MembershipSummary[];
}

export interface OrgResponse {
  id: string;
  name: string;
  slug: string;
  status: string;
  modules: ModuleItem[];
}

export interface MemberResponse {
  userId: string;
  email: string;
  name: string;
  status: string;
  joinedAt: string;
  permissions: string[];
}

export interface ImportOutcome {
  row: number;
  email: string;
  outcome: 'created' | 'already_member' | 'invited' | 'error';
  error?: string;
}

export interface ModuleItem {
  key: string;
  name: string;
  description: string;
  isCore: boolean;
  enabled: boolean;
  enabledAt: string | null;
}

export interface DeviceItem {
  id: string;
  clientId: string;
  name: string;
  orgId: string;
  status: string;
  permissions: string[];
  lastSeenAt: string | null;
  createdAt: string;
}

export interface ProvisionedDevice extends DeviceItem {
  clientSecret: string;
}

export interface PlatformOrg {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
}

// ─── Ski Swap ─────────────────────────────────────────────────────────────────

export interface SwapResponse {
  id: string;
  orgId: string;
  title: string;
  squareCategoryId: string;
  locationId: string;
  active: boolean;
  skuPrefix: string;
  createdAt: string;
  updatedAt: string;
}

export interface SellerResponse {
  id: string;
  orgId: string;
  name: string;
  phone: string;
  email: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ItemResponse {
  squareItemId: string;
  squareVariationId: string;
  swapId: string;
  name: string;
  description: string | null;
  sku: string;
  priceCents: number;
  inStock: number;
  soldCount: number;
  seller: { id: string; name: string; phone: string } | null;
  squareImageIds: string[];
}

export interface SwapStats {
  totalItems: number;
  totalSellers: number;
  itemsSold: number;
  grossRevenueCents: number;
}

export interface SquareConfigResponse {
  orgId: string;
  accessToken: '***';
  environment: 'sandbox' | 'production';
  updatedAt: string;
}

export interface PublicSellerItem {
  squareItemId: string;
  name: string;
  priceCents: number;
  originalQuantity: number;
  inStock: number;
  soldCount: number;
}

export interface PublicSellerLookupResponse {
  sellerName: string;
  items: PublicSellerItem[];
}
