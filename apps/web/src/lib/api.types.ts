/**
 * Every kind of device that can be provisioned, in the order the UI offers them.
 *
 * One list, because there are two dropdowns — provisioning and editing — and
 * hand-maintaining both is how the network printer adapter ended up impossible
 * to provision after the server already supported it.
 *
 * Mirrors `DeviceRoleSchema` in apps/api/src/contracts/devices.contracts.ts.
 */
export const DEVICE_ROLES = [
  {
    value: 'ski_swap.staff_check_in',
    label: 'Staff Check-In Station',
    hint: 'A tablet staff use to check sellers in. Assign it to a station once provisioned.',
  },
  {
    value: 'ski_swap.print_bridge',
    label: 'Print Bridge',
    hint: 'An ESP-32 that bridges wifi to a Phomemo over Bluetooth. Assign it to a station once provisioned.',
  },
  {
    value: 'time_clock.terminal',
    label: 'Time Clock',
    hint: 'A tablet patrollers clock in and out on.',
  },
] as const;

export type DeviceRole = (typeof DEVICE_ROLES)[number]['value'];

/**
 * The label for a role identifier.
 *
 * Identifiers are never shown to anyone — falling back to the raw value would
 * leak `ski_swap.print_bridge` into the UI, so an unknown role is better named
 * as unknown than printed verbatim.
 */
/**
 * What to call a device on screen.
 *
 * A print bridge has no name of its own. It is one printer's network adapter,
 * bought and mounted for that printer, and naming it separately only created
 * two labels for one physical pairing that could disagree — "Bridge 2" driving
 * "Printer A" tells you nothing and misleads a little.
 */
export function deviceLabel(device: { role: DeviceRole; name: string; printerName?: string | null }): string {
  if (device.role !== 'ski_swap.print_bridge') return device.name;
  return device.printerName ? `${device.printerName} bridge` : 'Unbound bridge';
}

export function deviceRoleLabel(role: string): string {
  return DEVICE_ROLES.find((r) => r.value === role)?.label ?? 'Unknown device';
}

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
  /** A bridge's last word on its BLE link to its printer, and when. Null otherwise. */
  printerLink: 'ready' | 'down' | null;
  printerLinkAt: string | null;
  /** The printer a bridge drives — and what the bridge is called. Null otherwise. */
  printerName: string | null;
  /** The station a bridge serves. Null when nothing routes work to it. */
  stationName: string | null;
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
  /** The bridge that drives this printer, and the station that bridge serves. */
  bridgeDeviceId: string | null;
  stationName: string | null;
}

/**
 * What a sign-in was for. Ids, never a URL — the client decides where to go, so
 * a stored redirect target can never become an open redirect.
 */
export interface SignInContext {
  swapId: string;
  stationId: string;
}

/** What a station QR resolves to, before anyone has signed in. */
export interface CheckinContext {
  orgId: string;
  orgName: string;
  orgLogoUrl: string | null;
  swapId: string;
  swapTitle: string;
  stationId: string;
  stationName: string;
}

export interface CheckinSummary {
  sellerId: string;
  sellerName: string;
  items: {
    id: string;
    name: string;
    sku: string;
    priceCents: number;
    hasPrintedTag: boolean;
  }[];
  totalCents: number;
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
  /** Derived from whether a staff tablet is bound, never stored. */
  kind: 'staffed' | 'self_service';
  attendantDeviceId: string | null;
  attendantName: string | null;
  attendantLastSeenAt: string | null;
  bridgeDeviceId: string | null;
  bridgeName: string | null;
  bridgeLastSeenAt: string | null;
  printerId: string | null;
  printerName: string | null;
  createdAt: string;
}

export interface StationQueueStatus {
  stationId: string;
  queued: number;
  claimed: number;
  /** A recipe that no longer resolves — the item was deleted mid-print. */
  failed: number;
  /** Retried to the cap and given up on. */
  abandoned: number;
  /** The bridge's last word on its link to the printer. */
  printerLink: 'ready' | 'down' | null;
  printerLinkAt: string | null;
  /** The printer a bridge drives — and what the bridge is called. Null otherwise. */
  printerName: string | null;
  /** The station a bridge serves. Null when nothing routes work to it. */
  stationName: string | null;
  oldestQueuedAt: string | null;
  bridgeLastSeenAt: string | null;
  attendantLastSeenAt: string | null;
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
