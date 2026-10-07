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
  /** `checkin` for a session started at a station: check-in only (Plan 33). */
  sessionScope: 'full' | 'checkin';
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
  /** Last sign-in or session renewal, accurate to 15 minutes. Null ⇒ never. */
  lastActiveAt?: string | null;
  /** A session is still open on some device. */
  signedIn?: boolean;
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
  /** When it last traded its client secret for a token: a pairing code was used. */
  lastTokenAt?: string | null;
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
   * How items come in, per place (Plan 34): a legacy ticket already on the
   * gear, or a print ticket, a tag printed here. Each place takes at least one.
   */
  allowLegacyCheckin: boolean;
  allowPrintCheckin: boolean;
  allowLegacyWeb: boolean;
  allowPrintWeb: boolean;
  /** The iPad prints a helper label with each legacy ticket at check-in. Only with `allowLegacyCheckin`. */
  printLegacyHelperLabels: boolean;
  /** Price tags printed each time an item's tag is printed, 1 to 3. */
  labelsPerItem: number;
  /** The public address segment: `<org>/<slug>/status` (Plan 33). */
  slug: string;
  /** Unauthenticated SKU Lookup. */
  skuLookupEnabled: boolean;
  /** Unauthenticated Seller Status: the email and last-4 lookup, and `/s/`. */
  sellerLookupEnabled: boolean;
  /** Authenticated Seller Status: an individual seller here may sign in. */
  sellerLoginEnabled: boolean;
  /** Where the swap happens, as an IANA zone: receipt times are given in it. */
  timeZone: string;
  /** Receipt settings (Plan 36). */
  receiptMode: ReceiptMode;
  receiptShowSku: boolean;
  receiptShowName: boolean;
  receiptShowPrice: boolean;
  receiptLink: ReceiptLinkChoice;
  receiptPrintEnabled: boolean;
  receiptPaperSize: ReceiptPaperSize;
  receiptFinePrintEnabled: boolean;
  /** Sanitized HTML. */
  receiptFinePrint: string | null;
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
  /** The Venmo handle was scanned from the seller's code (Plan 35). Unscanned isn't paid. */
  payoutHandleScanned: boolean;
  emailVerifiedAt: string | null;
  phoneVerifiedAt: string | null;
  /** Where a receipt would go, or null when there is nowhere to send one. */
  receiptChannel: 'EMAIL' | 'SMS' | null;
  /** The active swaps this seller has items in: what a receipt can be printed for. */
  receiptSwaps: {
    id: string;
    title: string;
    /** The paper its receipts print on, or null when it doesn't print them (Plan 36). */
    printPaperSize: ReceiptPaperSize | null;
  }[];
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
    /** The category this question really belongs to, when it isn't the item's own ("Bindings", Plan 44 D14). */
    via?: string | null;
  }[];
  /**
   * When a staff member accepted this item onto the floor.
   *
   * Null means it is waiting to be seen, and an item is in Square exactly when
   * this is set — so null is also the answer to "can this be sold".
   */
  consignedAt: string | null;
  /** When it was handed back to its seller, unsold (Plan 43), or null. */
  returnedAt?: string | null;
  /** Who handed it back, by name. Null unless returned. */
  returnedBy?: string | null;
  /** How many went back: the quantity less any sold. Null unless returned. */
  returnedUnits?: number | null;
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

/** A shop's issued tickets in one swap (Plan 38): each one an item from the start. */
export interface IssuedTicketSummary {
  /** The numbers held, as runs: 67000–67499. */
  runs: { startNumber: number; endNumber: number }[];
  issued: number;
  /** Described or priced by anyone. */
  described: number;
  /** Accepted but not yet in Square: still being put there, or stopped. */
  notInSquare: number;
  /** A push to Square is running for this swap right now. */
  pushing: boolean;
  /** The swap can reach Square at all. */
  squareReady: boolean;
}

/** What taking back returned tickets did (Plan 38). */
export interface RemoveTicketsResult {
  removed: number;
  kept: { sku: string; why: string }[];
}

/**
 * What a shop's item form opens with (Plan 38): the runs of tickets it holds,
 * the lowest nobody has described yet, and whether every one is described.
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
  /** `updated`: a ticket row filled in its issued ticket (Plan 38). */
  outcome: 'ok' | 'created' | 'updated' | 'error';
  error?: string;
  /** A row without a ticket that got a generated SKU (Plan 31). */
  generated?: boolean;
  /** The issued ticket a ticket row fills in (Plan 38). */
  itemId?: string;
  /** The category the row matched (Plan 42). */
  categoryId?: string;
  /** Cells that matched nothing, and so aren't stored (Plan 42). */
  unknown?: ImportUnknown[];
}

/** A category or detail cell an import couldn't match (Plan 42). */
export interface ImportUnknown {
  /** The detail as we spell it, or `category`. */
  column: string;
  value: string;
  reason: 'unknown_category' | 'unknown_value' | 'needs_parent' | 'out_of_range' | 'off_step' | 'not_a_number';
  /** The row's category, when we know it. */
  category?: string;
  /** A nested detail's parent ("Manufacturer"), and the row's answer to it ("Volkl"). */
  parent?: string;
  under?: string;
  /** For a number between the detail's steps: the step it goes in. */
  step?: number;
}

/** What an upload answers (Plan 42): each row, and whether the file was written. */
export interface TicketImportResult {
  rows: TicketImportRow[];
  /** Columns that are neither ours nor any category's detail. */
  ignoredColumns: string[];
  /** Why nothing was written; null once written. */
  refused: 'errors' | 'unknown' | null;
}

/** The downloads beside an item upload (Plan 42). */
export type ImportGuideFile = 'template.csv' | 'example.csv' | 'details.csv';

/** A seller staff can upload a file for: one holding tickets in this swap. */
export interface TicketSeller {
  sellerId: string;
  displayName: string;
  /** The runs of ticket numbers held. */
  ranges: { startNumber: number; endNumber: number }[];
  ticketCount: number;
  /** Tickets somebody has described or priced. */
  usedCount: number;
}

/**
 * The dashboard pie: every live item in exactly one slice, sold first (from
 * Square's sales, less refunds), then no price, then priced but no
 * description, then not on sale yet (waiting for a scan, or missing from
 * Square), then for sale.
 */
export interface ItemBreakdown {
  sold: number;
  /** Handed back to their sellers, unsold (Plan 43). */
  returned: number;
  forSale: number;
  /** No price yet. */
  noPrice: number;
  /** Priced, but never described: still named "Item #<sku>". */
  noDescription: number;
  notOnSale: number;
  total: number;
  /** When Square's sales were read (reused for two minutes). */
  asOf: string;
  /** Square couldn't be read; nothing else here should be shown. */
  error: string | null;
}

/** One hour of one day on the check-ins heat map, in the swap's time zone. */
export interface CheckinCell {
  /** "2026-10-04". */
  date: string;
  /** 0–23. */
  hour: number;
  individual: number;
  business: number;
  /** Indexes into the heat map's `sellers`: who checked items in that hour. */
  sellers: number[];
}

/** Item check-ins by day and hour. Days and hours run first to last, gaps included. */
export interface CheckinsHeatmap {
  timeZone: string;
  days: string[];
  hours: number[];
  /** Only cells with a check-in. */
  cells: CheckinCell[];
  sellers: { business: boolean }[];
}

/** The dashboard's figures, from our own rows only (Plan 39 D6): sales live in Square. */
export interface SwapStats {
  totalItems: number;
  totalSellers: number;
  /** Sellers here who were already sellers before this swap's first check-in. */
  returningSellers: number;
  /** Sellers who became sellers at or after the first check-in. */
  newSellers: number;
  /** Tickets still without a price (Plan 32). */
  unpricedItems: number;
  /** Priced, consigned items at listed prices: moves during check-in. */
  consignedValueCents: number;
  /** Consigned items, priced or not. */
  consignedItems: number;
  /** Consigned items still without a price, so not in the value. */
  consignedUnpriced: number;
}

/** The Items page's filters and sort (Plan 39): every one answered by the server. */
export type ItemListStatus = 'not_received' | 'not_in_square' | 'needs_price' | 'returned';

/** One return's answer (Plan 43). `already_returned` is a double scan, not an error. */
export interface ReturnResult {
  item: ItemResponse;
  outcome: 'returned' | 'already_returned';
  /** False when Square couldn't be read: returned anyway. */
  squareChecked: boolean;
}

/** A locked return session's list: the seller's items still out. */
export interface UnreturnedItems {
  items: { id: string; sku: string; name: string; priceCents: number | null; units: number }[];
  squareChecked: boolean;
}
export type ItemListSort = 'sku' | 'name' | 'price' | 'seller' | 'tag';
export interface ItemListView {
  status?: ItemListStatus;
  printed?: boolean;
  sort?: ItemListSort;
  dir?: 'asc' | 'desc';
}

/** A seller's items in a swap at listed prices, for the Receipt popup (Plan 39 D7). */
export interface SellerItemsSummary {
  items: number;
  listedValueCents: number;
  unpriced: number;
}

export interface SquareConfigResponse {
  orgId: string;
  accessToken: '***';
  environment: 'sandbox' | 'production';
  updatedAt: string;
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
  /** Whether finishing at this station prints a receipt (Plan 36). */
  receiptPrints: boolean;
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
  /** Barcodes on a tall (62 × 100) item tag: 1 across the foot, or 2, head and foot. */
  barcodesPerTicket: 1 | 2;
  /** Ski boots marked Mens, Womens or Kids are named with their US size too. */
  showUsBootSizes: boolean;
  /** Declared an NSSRA retail member (Plan 44 D5), by whom and when. */
  nssraMember: boolean;
  nssraMemberSetBy: string | null;
  nssraMemberSetAt: string | null;
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
  /** When it was handed back to the seller (Plan 43); absent from an older API. */
  returnedAt?: string | null;
}

export interface PublicSellerDetailSwap {
  swapId: string;
  swapTitle: string;
  items: PublicSellerDetailItem[];
}

export interface PublicSellerDetailResponse {
  /** False when none of the seller's swaps shows their status publicly (Plan 33). */
  available: boolean;
  sellerName: string | null;
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
  /** Whether the email and last-4 lookup can find anybody: a swap has it on (Plan 33). */
  sellerLookupOpen: boolean;
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

// ─── Binding indemnification (Plan 44) ───────────────────────────────────────

export type {
  IndemnificationAnswer,
  IndemnificationLine,
  BindingLookup,
  BindingLookupDetail,
  BindingLookupEntry,
  ManufacturerSummary,
  ManufacturersResponse,
  IndemnificationProgram,
  IndemnificationImportPlan,
  IndemnificationImportRecord,
  NssraDeclaration,
} from '@patrolkit/contracts/indemnification.contracts';

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
  /** The swap's zone: `createdAt` is shown in it, not in the viewer's. */
  timeZone: string;
  /** What this receipt shows, per its swap's settings now (Plan 36). */
  layout: ReceiptLayout;
  lines: PublicReceiptLine[];
}

export type ReceiptMode = 'ITEMIZED' | 'STATUS_ONLY' | 'NONE';
export type ReceiptLinkChoice = 'NONE' | 'SKU_LOOKUP' | 'SELLER_STATUS' | 'SELLER_LOGIN';
export type ReceiptPaperSize = '62x100' | '50x30';

/** The server's decision about a receipt (Plan 36): every renderer draws from it. */
export interface ReceiptLayout {
  mode: ReceiptMode;
  show: { sku: boolean; name: boolean; price: boolean };
  link: { url: string; kind: Exclude<ReceiptLinkChoice, 'NONE'> } | null;
  print: { paperSize: ReceiptPaperSize } | null;
  /** Sanitized HTML; null when off. */
  finePrint: string | null;
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

/** The SKU lookup page's header (Plan 33). */
export interface PublicSwapStatusPage {
  orgName: string;
  orgLogoUrl: string | null;
  swapTitle: string;
}

/** One SKU's status, as the public is told it (Plan 33): its name and status, nothing else. */
export interface PublicSkuStatus {
  sku: string;
  name: string;
  status: 'not_received' | 'for_sale' | 'sold' | 'returned' | 'unknown';
  soldCount?: number;
  quantity?: number;
}

/** A ticket still waiting for its price, for the fast edit (Plan 37). */
export type { UnpricedTicket } from '@patrolkit/contracts/ski-swap.contracts';
// Batch set category (Plan 45).
export type {
  CategorizeAnswer,
  CategorizeItemResult,
  CategorizeItemsResponse,
  UncategorizeItemResponse,
} from '@patrolkit/contracts/ski-swap.contracts';

// ─── Swap diagnostics (Plan 41) ──────────────────────────────────────────

export type {
  DiagnosticApplyAllResponse,
  DiagnosticChoice,
  DiagnosticField,
  DiagnosticIssueKind,
  DiagnosticIssueResponse,
  DiagnosticOurSide,
  DiagnosticRunResponse,
  DiagnosticSquareSide,
} from '@patrolkit/contracts/swap-diagnostics.contracts';
