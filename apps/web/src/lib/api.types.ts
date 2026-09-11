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
    // "Station" is the counter, not the tablet. Calling the hardware a station
    // too put two different things behind one word on the same page, on a
    // button that provisions a tablet.
    value: 'ski_swap.staff_check_in',
    label: 'Staff Tablet',
    hint: 'A tablet staff use to check sellers in. Normally set up with its station, on the Check-in page.',
  },
  {
    value: 'ski_swap.print_bridge',
    label: 'Print Bridge',
    hint: 'An ESP-32 that bridges wifi to a Phomemo over Bluetooth. Set it up over Bluetooth once provisioned.',
  },
  {
    value: 'time_clock.terminal',
    label: 'Time Clock',
    hint: 'A tablet patrollers clock in and out on.',
  },
  {
    value: 'signage.display',
    label: 'Display',
    hint: 'A screen in a patrol room. Set it up over Bluetooth once provisioned — it needs the Wi-Fi it will live on, and the PIN shown on the screen itself.',
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
  /**
   * The resort this device stands at. Null for a kind of device that has none,
   * for one nobody has placed yet, and for one whose resort was retired.
   */
  resortId: string | null;
  resortName: string | null;
  /**
   * What a device running the PatrolKit device image last reported when it
   * fetched its bootstrap manifest. Null for every other kind of device, and
   * for a display that has been provisioned but has never reached the server.
   */
  hardwareId: string | null;
  imageName: string | null;
  imageVersion: string | null;
  /** The raw `name=version,…` the device sent. Rendered, never parsed for meaning. */
  installedPackages: string | null;
  bootstrapAt: string | null;
  createdAt: string;
}

export interface ProvisionedDevice extends DeviceItem {
  clientSecret: string;
}

/** What the address and payout steps start from, sent with the join. */
export interface CheckinProfile {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  payoutMethod: 'PAYPAL' | 'VENMO' | 'CHECK' | 'DONATE' | null;
  payoutTarget: 'EMAIL' | 'PHONE' | 'PAYPAL_ID' | 'VENMO_ID' | null;
  payoutHandle: string | null;
  verifiedEmail: string | null;
  verifiedPhone: string | null;
}

export interface CheckinJoined extends CheckinContext {
  sellerId: string;
  needsName: boolean;
  profile: CheckinProfile;
}

export interface PlatformUserMembership {
  id: string;
  orgId: string;
  orgName: string;
  /** Soft-removed: they were a member and are not any more. */
  removed: boolean;
}

export interface PlatformUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  isSuperAdmin: boolean;
  createdAt: string;
  memberships: PlatformUserMembership[];
}

export interface PlatformUserPage {
  users: PlatformUser[];
  total: number;
  page: number;
  limit: number;
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
  /**
   * Whether this swap takes gear already carrying a numbered ticket from the
   * stockpile, rather than a tag printed at check-in — for a business seller
   * working through a block, or an individual handed a loose one at the counter.
   */
  legacyTicketsEnabled: boolean;
  /**
   * Whether the stockpile is the only way in — no printed tags at all.
   *
   * Only meaningful alongside `legacyTicketsEnabled`; the server clears this
   * when that goes off, so the two can never contradict each other.
   */
  legacyTicketsOnly: boolean;
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
  /** PayPal Payouts' recipient type, or the kind of ID that was typed. */
  payoutTarget: 'EMAIL' | 'PHONE' | 'PAYPAL_ID' | 'VENMO_ID' | null;
  /** The typed value, for PAYPAL_ID and VENMO_ID only. */
  payoutHandle: string | null;
  emailVerifiedAt: string | null;
  phoneVerifiedAt: string | null;
  /** Set once removed. Only ever populated for a caller passing `updatedSince`. */
  deletedAt: string | null;
  createdAt: string;
  /** `Membership.updatedAt` — the delta-sync watermark, not the profile's own. */
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
  /**
   * What this item is, as the tree reads it now. Null for one an importer
   * created from a name alone.
   *
   * `name` above is the historic record — derived once and frozen, and what the
   * tag and the receipt say. These are resolved through the tree on every read,
   * so the two are allowed to disagree after an administrator tidies a label.
   */
  category: { id: string; label: string } | null;
  attributes: {
    attributeId: string;
    attributeLabel: string;
    valueId: string | null;
    /** Already rendered: a value's label, or a number with its unit. */
    valueLabel: string;
    numberValue: number | null;
  }[];
  /**
   * When a staff member accepted this item onto the floor.
   *
   * Null means it is waiting to be seen, and an item is in Square exactly when
   * this is set — so null is also the answer to "can this be sold".
   */
  consignedAt: string | null;
  seller: { id: string; displayName: string; phone: string | null } | null;
  photos: { id: string; url: string }[];
  /**
   * Tracks the item record, not its stock. `inStock` and `soldCount` are read
   * live from Square on every request, so a sale moves neither this nor any
   * other column — a delta sync sees edits, not sales.
   */
  updatedAt: string;
}

/** A block of pre-printed tickets issued to a business seller for one swap. */
export interface LegacyTicketRange {
  id: string;
  swapId: string;
  sellerId: string;
  startNumber: number;
  endNumber: number;
  ticketCount: number;
  /** Derived from the items, so it counts numbers actually on goods. */
  usedCount: number;
}

/**
 * What the item form opens with.
 *
 * `suggested: null` with `exhausted: false` is the ordinary state past the top
 * of a range: nothing to offer, but a skipped ticket may still be entered.
 */
export interface TicketFormState {
  ranges: { startNumber: number; endNumber: number }[];
  suggested: number | null;
  exhausted: boolean;
}

/** One row's fate in a ticket-item import. */
export interface TicketImportRow {
  line: number;
  sku: string;
  outcome: 'ok' | 'created' | 'error';
  error?: string;
}

/** A seller staff can upload a file for: one holding tickets in this swap. */
export interface TicketSeller {
  sellerId: string;
  displayName: string;
  ranges: { startNumber: number; endNumber: number }[];
  ticketCount: number;
  usedCount: number;
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
  /**
   * Whether a self check-in item waits for a staff member to scan it before it
   * goes on sale.
   *
   * Describes what happens to items checked in from now on. It is read once, at
   * check-in, and the answer stored on the item, so this says nothing about
   * what is already on the floor.
   */
  requireConsignmentScan: boolean;
}

/**
 * The PIN that unlocks a device's settings screen, for whichever module asked.
 *
 * Null means no PIN is set, which means the screen opens unguarded — not that
 * the caller was refused a look. Being refused is a 403; this shape only ever
 * reaches someone entitled to the answer.
 */
export interface DevicePinResponse {
  devicePin: string | null;
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
  /** False while the item is still waiting for a staff member to accept it. */
  consigned: boolean;
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

// ─── Device bootstrap (platform admin) ───────────────────────────────────────

export interface BootstrapRepositoryItem {
  id: string;
  name: string;
  uri: string;
  suite: string;
  components: string[];
  arch: 'arm64' | 'armhf';
  /**
   * The signing key fingerprint. The server cannot validate this: every key a
   * device honours is baked into its image, and a manifest naming any other is
   * rejected on the device, silently.
   */
  signedByKeyId: string;
  pinPriority: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BootstrapPackageItem {
  id: string;
  name: string;
  /** Null means track the newest the repository carries. */
  version: string | null;
  /** What tracking last resolved to, and when it last asked. */
  resolvedVersion: string | null;
  resolvedAt: string | null;
}

export interface BootstrapProfileItem {
  id: string;
  role: DeviceRole;
  deviceType: string;
  enabled: boolean;
  updateEnabled: boolean;
  updateWindow: string | null;
  checkinIntervalSec: number;
  /** Counts edits. Devices compare the ETag over the resolved manifest instead. */
  manifestVersion: number;
  repositories: BootstrapRepositoryItem[];
  packages: BootstrapPackageItem[];
  updatedAt: string;
}

export interface BootstrapRepositoryInput {
  name: string;
  uri: string;
  suite: string;
  components: string[];
  arch: 'arm64' | 'armhf';
  signedByKeyId: string;
  pinPriority?: number | null;
}

export interface BootstrapProfileInput {
  deviceType: string;
  enabled: boolean;
  updateEnabled: boolean;
  updateWindow: string | null;
  checkinIntervalSec: number;
  repositoryIds: string[];
  packages: { name: string; version: string | null }[];
}

/** Exactly what a device of this role would be served, and under what ETag. */
export interface ManifestPreview {
  manifest: Record<string, unknown> | null;
  etag: string | null;
  /** Why a manifest cannot currently be produced, if it cannot. */
  error: string | null;
}

// ─── Device images ────────────────────────────────────────────────────────────

/** One published image, as listed for download. No S3 key: the server presigns. */
export interface DeviceImageItem {
  name: string;
  version: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  gitSha: string;
  builtAt: string;
  /** apt signing keys the image will trust. Shown for provenance. */
  trustedKeys: string[];
  notes: string;
}

/** An image as Platform Admin sees it, with whether it is the promoted one. */
export interface AdminDeviceImageItem extends DeviceImageItem {
  promoted: boolean;
  promotedAt: string | null;
  promotedBy: string | null;
}

export interface DeviceImageDownload {
  url: string;
  expiresInSec: number;
  filename: string;
  sha256: string;
  sizeBytes: number;
}

// ─── Item description tree (Plan 19) ─────────────────────────────────────────
//
// Re-exported from the API contracts rather than mirrored by hand. These shapes
// are recursive — an attribute holds values, a value holds attributes — and a
// hand copy of that is how a response and the schema documenting it drift apart
// without anything failing to compile.
//
// `import type` only: the contract module imports zod and nestjs-zod, and a
// value import would drag both into the browser bundle. Types are erased.

export type {
  ResolvedIcon,
  ResolvedTaxonomy,
  ResolvedCategory,
  ResolvedAttribute,
  ResolvedValue,
  TaxonomyChildrenResponse,
  TaxonomyAdminNode,
  OrgTaxonomyAdmin,
  PendingValue,
  TaxonomySuggestion,
} from '@patrolkit/contracts/taxonomy.contracts';

/** One answered question, on the way to the server. */
export interface ItemAttributeInput {
  attributeId: string;
  valueId?: string;
  numberValue?: number;
  /** A value the seller typed. Mints a value the org has yet to approve. */
  freeText?: string;
}
