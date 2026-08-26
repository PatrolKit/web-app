export type DeviceRole =
  | 'Ski Swap - Check-In'
  | 'Ski Swap - Bulk Seller'
  /** An ESP-32 bridging wifi to a Phomemo over BLE — it forwards bytes, nothing more. */
  | 'Ski Swap - Network Printer Adapter'
  | 'Time Clock';

// Shared types used by the web API client
// These mirror the API contract shapes (source of truth is apps/api/src/contracts/)

export type OrgRole = 'seller' | 'patroller';

export interface MembershipSummary {
  orgId: string;
  orgName: string;
  orgSlug: string;
  permissions: string[];
  /** Roles held at this org, derived from live profile rows. */
  roles: OrgRole[];
}

export interface MeResponse {
  id: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  /** Collapsed for display; never empty. */
  displayName: string;
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
  membershipId: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  joinedAt: string;
  /** Soft removal — null means a live member. */
  removedAt: string | null;
  permissions: string[];
  roles: OrgRole[];
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
  role: DeviceRole;
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
  /** SellerProfile id — the public /s/:sellerId identifier. */
  id: string;
  orgId: string;
  userId: string;
  /** Set means a business seller; null means individual. */
  businessName: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  phone: string | null;
  email: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  payoutMethod: 'PAYPAL' | 'VENMO' | 'CHECK' | 'DONATE' | null;
  /** Payouts target a verified contact rather than a free-text identifier. */
  payoutChannel: 'email' | 'phone' | null;
  emailVerifiedAt: string | null;
  phoneVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Cross-org lookup discloses a name and nothing more until staff confirm. */
export interface PersonSearchResult {
  userId: string;
  displayName: string;
  alreadyHere: boolean;
}

export interface BusinessSellerMember {
  userId: string;
  sellerId: string;
  email: string | null;
  businessName: string | null;
  displayName: string;
  phone: string | null;
  joinedAt: string;
  removedAt: string | null;
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
  seller: { id: string; displayName: string; phone: string | null } | null;
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

/**
 * What a sign-in was for. Ids, never a URL — the client decides where to go, so
 * a stored redirect target can never become an open redirect.
 */
export interface SignInContext {
  swapId: string;
  stationId: string;
}

export interface RenderLabelResponse {
  format: 'escpos' | 'png';
  /** Base64. One entry per label — a receipt's item list paginates. */
  pages: string[];
}

export interface CheckinStationRecord {
  id: string;
  name: string;
  code: string;
  deviceId: string | null;
  deviceName: string | null;
  deviceLastSeenAt: string | null;
  printerId: string | null;
  printerName: string | null;
  createdAt: string;
}

export interface StationQueueStatus {
  stationId: string;
  queued: number;
  claimed: number;
  abandoned: number;
  oldestQueuedAt: string | null;
  deviceLastSeenAt: string | null;
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

export interface ResortResponse {
  id: string;
  orgId: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** IANA zone, derived from the address unless an admin overrode it. */
  timeZone: string;
  updatedAt: string;
}

export interface ResortInput {
  name?: string;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  timeZone?: string;
}

// ─── Time Clock ───────────────────────────────────────────────────────────────

export interface PatrollerResponse {
  id: string;
  orgId: string;
  firstName: string;
  lastName: string;
  displayName: string;
  nspId: string;
  patrolLevel: string | null;
  email: string | null;
  phone: string | null;
  /** True once the person has proved control of either contact channel. */
  contactVerified: boolean;
  active: boolean;
  deletedAt: string | null;
  updatedAt: string;
}

export interface TimeClockSettingsResponse {
  orgId: string;
  autoCloseLocalTime: string;
  autoCloseAfterHours: number;
  updatedAt: string;
}

export interface ShiftResponse {
  id: string;
  orgId: string;
  resortId: string;
  resortName: string | null;
  patrollerId: string;
  patrollerName: string | null;
  patrolLevel: string | null;
  nspId: string | null;
  dutyType: string;
  dutyNote: string | null;
  clockInAt: string;
  clockOutAt: string | null;
  status: string;
  closeReason: string | null;
  flagged: boolean;
  updatedAt: string;
}

export interface HoursReportRow {
  patrollerId: string;
  patrollerName: string;
  nspId: string;
  patrolLevel: string | null;
  shiftCount: number;
  totalMinutes: number;
  minutesByDutyType: Record<string, number>;
}
