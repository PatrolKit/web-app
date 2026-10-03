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
  /** When the member was last emailed an invite to sign in. Null ⇒ never. */
  inviteSentAt: string | null;
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
  /** Every station a bridge serves, one name each (Plan 27). */
  stationNames: string[];
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
  /** The web takes legacy tickets only (Plan 31); `legacyTicketsOnly` is staff check-in's. */
  webLegacyTicketsOnly: boolean;
  /**
   * Whether the staff iPad prints a helper label with each legacy ticket.
   * Only ever true alongside `legacyTicketsOnly`; the server clears it with that.
   */
  printLegacyHelperLabels: boolean;
  /** Price tags printed each time an item's tag is printed, 1 to 3. */
  labelsPerItem: number;
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
  /** Where a receipt would go, or null when there is nowhere to send one. */
  receiptChannel: 'EMAIL' | 'SMS' | null;
  /** The active swaps this seller has items in: what a receipt can be printed for. */
  receiptSwaps: { id: string; title: string }[];
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
  priceCents: number | null;
  originalQuantity: number;
  inStock: number;
  soldCount: number;
  /**
   * Whether `inStock` and `soldCount` are Square's answer. False when Square
   * could not be read; the numbers then say "unsold" as a placeholder.
   */
  inventoryKnown: boolean;
  squareSynced: boolean;
  donateProceeds: boolean;
  hasPrintedTag: boolean;
  /**
   * This item's tag came out of a box rather than a printer, so there is no
   * making another. `hasPrintedTag` says a tag exists; this says we cannot
   * produce one.
   */
  legacyTicket: boolean;
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
  /**
   * When this item was withdrawn, or null.
   *
   * Only ever set on an item from a `updatedSince` delta. A plain list has no
   * tombstones in it, so a screen never sees this as anything but null.
   */
  deletedAt: string | null;
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
  /** The swap's web takes legacy tickets only (Plan 31). */
  webTicketsOnly: boolean;
}

/** One row's fate in a ticket-item import. */
export interface TicketImportRow {
  line: number;
  /** The ticket, or once created, the SKU generated for a row without one. */
  sku: string;
  outcome: 'ok' | 'created' | 'error';
  error?: string;
  /** A row without a ticket that got a generated SKU (Plan 31). */
  generated?: boolean;
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
  /** At listed prices, so priced items only. */
  grossRevenueCents: number;
  /** Units of tickets sold before they were priced, not in the revenue above (Plan 32). */
  unpricedSold: number;
  /** Tickets still without a price, sold or not (Plan 32). */
  unpricedItems: number;
  /** False when Square could not be read; sold and revenue are then 0, not answers. */
  inventoryKnown: boolean;
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
  priceCents: number | null;
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
  model: import('./printing/PhomemoPrinterService').PrinterModelId;
  paperSize: import('./printing/PhomemoPrinterService').PaperSize;
  marginTop:    number;
  marginBottom: number;
  marginLeft:   number;
  marginRight:  number;
  assignedSellerId: string | null;
  assignedSellerName: string | null;
  /** The bridge that drives this printer, and the stations that bridge serves, joined. */
  bridgeDeviceId: string | null;
  stationName: string | null;
  stationNames: string[];
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
    priceCents: number | null;
    hasPrintedTag: boolean;
  }[];
  /** Of the priced items only. */
  totalCents: number;
  /** Tickets checked in without a price yet (Plan 32). */
  unpricedCount: number;
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
  /** The other stations printing through this station's bridge (Plan 27). */
  bridgeSharedWith: string[];
  /** Its bridge's printer holds 25 × 67: legacy helper labels only (Plan 28). */
  helperLabelsOnly: boolean;
  createdAt: string;
}

export interface StationQueueStatus {
  stationId: string;
  queued: number;
  claimed: number;
  /** A recipe that no longer resolves — the item was deleted mid-print. */
  failed: number;
  /** Retried to the cap and given up on, or a helper pair not printed within its minute. */
  abandoned: number;
  /** Why the most recent of those was given up on. */
  lastAbandonedReason: string | null;
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
  /** The app the staff tablet last reported: "1.4.0" and its build. */
  attendantAppVersion: string | null;
  attendantAppBuild: string | null;
  /** The other stations printing through the same bridge (Plan 27). */
  bridgeSharedWith: string[];
}

/** A barcode scanner an org owns, and the bridge that drives it. */
export interface SwapScanner {
  id: string;
  name: string;
  bluetoothName: string;
  bridgeDeviceId: string | null;
  /** The stations the driving bridge serves, joined, when it serves any. */
  stationName: string | null;
  stationNames: string[];
}

export interface SkiSwapSettings {
  /** Deprecated: read the swap's `labelsPerItem`. Still sent for older iPads. */
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
  /** The org's cut, as a percentage: "20%", "20.5%", "0%". */
  commissionPercent: string;
  /** The same number the server does the arithmetic with. */
  commissionBasisPoints: number;
}

// ─── Payouts (Plan 25) ──────────────────────────────────────────────────

export interface PayPalConfigResponse {
  orgId: string;
  clientId: string;
  environment: 'sandbox' | 'live';
  webhookId: string | null;
  /** There is no secret field. This is all the UI is told about it. */
  hasSecret: boolean;
  updatedAt: string;
}

export type PayoutLineStatus =
  | 'PENDING' | 'APPROVED' | 'SENDING' | 'SENT' | 'UNCLAIMED'
  | 'FAILED' | 'RETURNED' | 'PAID_BY_CHECK' | 'DONATED';

export type PayoutMethod = 'PAYPAL' | 'VENMO' | 'CHECK' | 'DONATE';

export interface PayoutLineItem {
  id: string;
  itemId: string | null;
  name: string;
  sku: string;
  priceCents: number;
  quantity: number;
  /** What the register took, which may be less than listed. Evidence, not pay. */
  collectedCents: number;
  squareOrderId: string;
  soldAt: string;
  refundedQty: number;
}

export interface PayoutLine {
  id: string;
  sellerId: string;
  sellerName: string;
  method: PayoutMethod;
  destination: string | null;
  destinationType: 'EMAIL' | 'PHONE' | 'PAYPAL_ID' | 'VENMO_ID' | null;
  grossCents: number;
  commissionCents: number;
  netCents: number;
  status: PayoutLineStatus;
  statusNote: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  payoutBatchId: string | null;
  payoutItemId: string | null;
  checkNumber: string | null;
  checkSentAt: string | null;
  items: PayoutLineItem[];
}

export interface PayoutRun {
  id: string;
  swapId: string;
  swapTitle: string;
  status: 'DRAFT' | 'REVIEW' | 'CLOSED';
  salesFrom: string;
  salesTo: string;
  commissionBasisPoints: number;
  sendAttempt: number;
  createdAt: string;
  closedAt: string | null;
  totals: { grossCents: number; commissionCents: number; netCents: number };
  byStatus: Record<string, number>;
  /**
   * Sales in the window that matched no item of this swap.
   *
   * Money the org took that nobody is being paid for — a manual register
   * entry, a mis-scan, or another swap's stock at the same location.
   */
  unmatchedSales: { variationId: string; orderId: string; collectedCents: number }[];
  lines: PayoutLine[];
}

export interface PayoutRunSummary {
  id: string;
  swapId: string;
  swapTitle: string;
  status: 'DRAFT' | 'REVIEW' | 'CLOSED';
  createdAt: string;
  closedAt: string | null;
  lineCount: number;
  unmatchedCount: number;
  totalNetCents: number;
  byStatus: Record<string, number>;
}

/** A sale the register took less for than the item listed at. */
export interface PayoutDiscount {
  itemId: string | null;
  name: string;
  sku: string;
  sellerName: string;
  listedCents: number;
  collectedCents: number;
  gapCents: number;
  /** Collected nothing: a give-away, or a match against the wrong item. */
  zeroCollected: boolean;
}

/**
 * What a seller is owed and what became of it, on their own status page.
 *
 * `destination` is masked by the server: this page needs no sign-in, so it is
 * as public as whoever holds the link.
 */
export interface PublicSellerPayout {
  swapTitle: string;
  status: PayoutLineStatus;
  grossCents: number;
  commissionCents: number;
  netCents: number;
  /** "20%" — what the arithmetic above took. */
  commissionPercent: string;
  method: PayoutMethod;
  destination: string | null;
  sentAt: string | null;
  checkSentAt: string | null;
  /** Unclaimed: the one state where the seller is the person who can act. */
  needsAction: boolean;
}

export interface CheckPayee {
  sellerName: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  amountCents: number;
  reference: string;
  checkNumber: string | null;
  sentAt: string | null;
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
  priceCents: number | null;
  originalQuantity: number;
  inStock: number;
  soldCount: number;
  /**
   * Whether `soldCount` is Square's answer. False when Square could not be
   * read. Optional because this page is reached from a printed tag and may
   * run against an older API; absent reads as known, which is what it was.
   */
  inventoryKnown?: boolean;
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
  /**
   * How this seller chose to be paid, so the page can say roughly when.
   * Null for a seller who has not been asked yet.
   */
  payoutMethod: PayoutMethod | null;
  /** Newest first. Empty until a payout run has been built (Plan 25 §8). */
  payouts: PublicSellerPayout[];
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

// ─── Receipts (Plan 24) ──────────────────────────────────────────────────────

export interface SendReceiptResponse {
  receiptId: string;
  channel: 'EMAIL' | 'SMS';
  /** The address or number it went to, so the UI can name it. */
  destination: string;
  /**
   * SUPPRESSED means the send was deliberately not made — `OUTBOUND_NOTIFICATIONS`
   * is off. The UI must not report it as delivered.
   */
  status: 'SENT' | 'SUPPRESSED' | 'FAILED';
  sentAt: string;
  url: string;
}

export interface PublicReceiptLine {
  name: string;
  sku: string;
  priceCents: number | null;
}

/** A frozen receipt, as the public page and the create call receive it. */
export interface PublicReceiptResponse {
  id: string;
  token: string;
  orgName: string;
  orgLogoUrl: string | null;
  /** The logo as a URL a mail client could fetch, or null. Email only. */
  logoImageUrl: string | null;
  swapTitle: string;
  sellerName: string;
  payoutLabel: string | null;
  /** Of the priced lines only. */
  totalCents: number;
  itemCount: number;
  /** Lines of tickets not yet priced (Plan 32), which the total leaves out. */
  unpricedCount: number;
  createdAt: string;
  /** This receipt, frozen. */
  url: string;
  /** The seller's live page: everything they have, not only what is on here. */
  trackUrl: string;
  lines: PublicReceiptLine[];
}

export interface SellerReceiptRow {
  id: string;
  createdAt: string;
  itemCount: number;
  totalCents: number;
  revokedAt: string | null;
  url: string;
  deliveries: {
    channel: 'EMAIL' | 'SMS';
    destination: string;
    status: 'SENT' | 'SUPPRESSED' | 'FAILED';
    error: string | null;
    createdAt: string;
  }[];
}

// ─── Server health (Plan 26 §11) ─────────────────────────────────────────────

export type HealthRange = '24h' | '7d' | '30d' | '90d';

/** What a limit counts per. */
export type LimitKeyedBy = 'ip' | 'caller' | 'destination' | 'site';

export interface HealthPlace {
  org: { id: string; name: string } | null;
  swap: { id: string; title: string } | null;
}

export interface LimitSummary {
  id: string;
  label: string;
  keyedBy: LimitKeyedBy;
  limit: number;
  windowSeconds: number;
  /** The closest any key came in the range, or null when nothing was counted. */
  peak: (HealthPlace & { percent: number; hits: number; limit: number; hourStart: string }) | null;
  nearCount: number;
  refusedCount: number;
}

export interface LimitsHealth {
  range: HealthRange;
  generatedAt: string;
  limits: LimitSummary[];
}

export interface LimitSeries {
  id: string;
  range: HealthRange;
  bucket: 'hour' | 'day';
  points: { at: string; percent: number | null; refusedCount: number }[];
  top: (HealthPlace & { percent: number; refusedCount: number; nearCount: number })[];
}

// ─── Device telemetry (webprinter_esp32 Plan 4) ─────────────────────────────

export type TelemetryRange = '24h' | '7d' | '30d' | '90d';

export interface TelemetryBridge {
  id: string;
  name: string;
  clientId: string;
  org: { id: string; name: string };
  station: string | null;
  lastSeenAt: string | null;
  online: boolean;
}

export interface TelemetryLatest {
  receivedAt: string;
  firmwareVersion: string | null;
  board: string | null;
  psram: boolean | null;
  bootCount: number | null;
  resetReason: string | null;
  bootAt: string | null;
  memFree: number | null;
  memLargestBlock: number | null;
  memMinFreeEver: number | null;
  wifiRssi: number | null;
  printerLink: string | null;
}

export interface TelemetryTotals {
  reboots: number;
  unplannedReboots: number;
  outages: number;
  disconnectedMs: number;
  lowestMemory: number | null;
  reports: number;
}

export interface TelemetryFleet {
  range: TelemetryRange;
  generatedAt: string;
  totals: {
    bridges: number;
    online: number;
    reporting: number;
    reboots: number;
    unplannedReboots: number;
    disconnectedMs: number;
    lowestMemory: number | null;
  };
  firmware: { version: string; bridges: number }[];
  resetReasons: { reason: string; reboots: number; unplanned: boolean }[];
  bridges: (TelemetryBridge & TelemetryTotals & { latest: TelemetryLatest | null })[];
}

export interface TelemetryBridgeHistory {
  range: TelemetryRange;
  generatedAt: string;
  bridge: TelemetryBridge & { intervalS: number; intervalIsDefault: boolean };
  latest: (TelemetryLatest & { body: unknown; malformedFields: string[] | null }) | null;
  totals: TelemetryTotals;
  memory: {
    bucketMs: number;
    points: { at: string; free: number | null; minFreeEver: number | null; largestBlock: number | null }[];
  };
  reboots: {
    at: string;
    reason: string | null;
    unplanned: boolean;
    crash: boolean;
    bootCount: number | null;
    missed: number;
    firmwareVersion: string | null;
  }[];
  outages: { startedAt: string; endedAt: string | null; ms: number }[];
}

/** Platform Admin → Configuration (Plan 29). */
export interface PlatformSettings {
  smsEnabled: boolean;
  updatedAt: string;
  /** Who last changed it, by name. Null before anyone has. */
  updatedBy: string | null;
  /** Whether a text would actually leave with the switch on. */
  smsReadiness: { originationNumber: boolean; outboundNotifications: boolean };
}
