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
  logoUrl: string | null;
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
  role: 'Ski Swap - Check-In' | 'Ski Swap - Bulk Seller';
  orgId: string;
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
  type: 'individual' | 'business';
  name: string;
  phone: string;
  email: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  payoutMethod: 'PAYPAL' | 'VENMO' | 'CHECK' | 'DONATE' | null;
  payoutIdentifierType: 'EMAIL' | 'PHONE' | 'USER_HANDLE' | null;
  payoutIdentifier: string | null;
  payoutIdentifierConfirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessSellerMember {
  userId: string;
  email: string;
  name: string;
  status: string;
  joinedAt: string;
  seller: { id: string; name: string; email: string | null; phone: string } | null;
}

export interface ItemResponse {
  id: string;
  swapId: string;
  orgId: string;
  name: string;
  description: string | null;
  sku: string;
  priceCents: number;
  originalQuantity: number;
  inStock: number;
  soldCount: number;
  squareSynced: boolean;
  donateProceeds: boolean;
  hasPrintedTag: boolean;
  seller: { id: string; name: string; phone: string } | null;
  photos: { id: string; url: string }[];
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
  itemId: string;
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

export interface SwapPrinterRecord {
  id: string;
  name: string;
  bluetoothName: string;
  paperSize: '40x30' | '50x30';
  marginTop:    number;
  marginBottom: number;
  marginLeft:   number;
  marginRight:  number;
  assignedSellerId: string | null;
  assignedSellerName: string | null;
}

export interface SkiSwapSettings {
  labelsPerItem: number;
}

// ─── Public seller detail ─────────────────────────────────────────────────────

export interface PublicSellerDetailItem {
  itemId: string;
  name: string;
  sku: string;
  priceCents: number;
  originalQuantity: number;
  inStock: number;
  soldCount: number;
  donateProceeds: boolean;
}

export interface PublicSellerDetailSwap {
  swapId: string;
  swapTitle: string;
  items: PublicSellerDetailItem[];
}

export interface PublicSellerDetailResponse {
  sellerName: string;
  orgName: string;
  orgLogoUrl: string | null;
  swaps: PublicSellerDetailSwap[];
}

export interface SellerFindResponse {
  sellerId: string;
}

export interface OrgBrandingResponse {
  orgName: string;
  logoUrl: string | null;
}
