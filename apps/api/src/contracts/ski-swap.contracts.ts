import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// ─── Square Config ────────────────────────────────────────────────────────────

export const UpsertSquareConfigSchema = z
  .object({
    accessToken: z.string().min(1),
    environment: z.enum(['sandbox', 'production']).default('production'),
  })
  .strict();

export const SquareConfigResponseSchema = z.object({
  orgId: z.string(),
  accessToken: z.literal('***'),
  environment: z.enum(['sandbox', 'production']),
  updatedAt: z.string().datetime(),
});

export class UpsertSquareConfigDto extends createZodDto(UpsertSquareConfigSchema) {}
export type SquareConfigResponse = z.infer<typeof SquareConfigResponseSchema>;

// ─── Swaps ────────────────────────────────────────────────────────────────────

export const CreateSwapSchema = z
  .object({ title: z.string().min(1).max(100), locationId: z.string().min(1) })
  .strict();

export const PatchSwapSchema = z
  .object({
    title: z.string().min(1).max(100).optional(),
    active: z.boolean().optional(),
    locationId: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.active !== undefined || v.locationId !== undefined, {
    message: 'At least one field must be provided',
  });

export const SwapResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  title: z.string(),
  squareCategoryId: z.string(),
  locationId: z.string(),
  active: z.boolean(),
  skuPrefix: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export class CreateSwapDto extends createZodDto(CreateSwapSchema) {}
export class PatchSwapDto extends createZodDto(PatchSwapSchema) {}
export type SwapResponse = z.infer<typeof SwapResponseSchema>;

// ─── Sellers ─────────────────────────────────────────────────────────────────

const PAYOUT_METHODS = ['PAYPAL', 'VENMO', 'CHECK', 'DONATE'] as const;

/**
 * A payout targets one of the person's own contacts rather than a free-text
 * identifier, so there is one verification concept instead of two. The service
 * layer rejects a channel that is not verified.
 */
const PayoutFields = {
  payoutMethod: z.enum(PAYOUT_METHODS).nullable().optional(),
  payoutChannel: z.enum(['email', 'phone']).nullable().optional(),
};

/** Person fields live on User and are global; they are edited through the seller API for convenience. */
const PersonFields = {
  firstName: z.string().trim().max(100).nullable().optional(),
  lastName: z.string().trim().max(100).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  street: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(50).nullable().optional(),
  zip: z.string().max(20).nullable().optional(),
};

export const CreateSellerSchema = z
  .object({
    ...PersonFields,
    /// Set ⇒ business seller. Null or absent ⇒ individual.
    businessName: z.string().trim().min(1).max(100).nullable().optional(),
    ...PayoutFields,
  })
  .strict()
  .refine((v) => Boolean(v.email || v.phone || (v.firstName && v.lastName) || v.businessName), {
    message: 'A seller needs at least a name, an email, or a phone number',
  });

export const PatchSellerSchema = z
  .object({
    ...PersonFields,
    businessName: z.string().trim().min(1).max(100).nullable().optional(),
    ...PayoutFields,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const SellerResponseSchema = z.object({
  /// SellerProfile id — the public /s/:sellerId identifier and the FK items point at.
  id: z.string(),
  orgId: z.string(),
  userId: z.string(),
  businessName: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  /// businessName, else "First Last", else a contact. Never empty.
  displayName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  payoutMethod: z.enum(PAYOUT_METHODS).nullable(),
  payoutChannel: z.enum(['email', 'phone']).nullable(),
  emailVerifiedAt: z.string().datetime().nullable(),
  phoneVerifiedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Cross-org lookup discloses a name and nothing else. The full record follows
 * only after staff confirm identity with the person in front of them.
 */
export const PersonSearchResultSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  /// True when this person already has a live seller profile at this org.
  alreadyHere: z.boolean(),
});

export const PersonSearchSchema = z
  .object({
    email: z.string().trim().toLowerCase().optional(),
    phone: z.string().trim().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.email || v.phone), { message: 'Provide an email or a phone number' });

export const AddSellerFromPersonSchema = z.object({ userId: z.string().min(1) }).strict();

export class CreateSellerDto extends createZodDto(CreateSellerSchema) {}
export class PatchSellerDto extends createZodDto(PatchSellerSchema) {}
export class PersonSearchDto extends createZodDto(PersonSearchSchema) {}
export class AddSellerFromPersonDto extends createZodDto(AddSellerFromPersonSchema) {}
export type SellerResponse = z.infer<typeof SellerResponseSchema>;
export type PersonSearchResult = z.infer<typeof PersonSearchResultSchema>;

// ─── Items ────────────────────────────────────────────────────────────────────

export const CreateItemSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    priceCents: z.number().int().positive(),
    quantity: z.number().int().positive(),
    sellerId: z.string().optional(),
    donateProceeds: z.boolean().default(false),
    sku: z.string().max(20).optional(),
    /**
     * The counter this was checked in at. Decides which station's queue prints
     * the tag and which code namespaces the SKU.
     */
    stationId: z.string().optional(),
    /**
     * The tag is already on the item — printed over Bluetooth by the client
     * rather than through the station's bridge.
     *
     * Skips the enqueue. Without it, an item checked in while the network was
     * down would print a second tag when it finally syncs, and during an outage
     * that happens for every item, discovered as a pile of orphan tags nobody
     * can place.
     */
    alreadyPrinted: z.boolean().optional(),
  })
  .strict();

export const PatchItemSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    priceCents: z.number().int().positive().optional(),
    quantity: z.number().int().nonnegative().optional(),
    sellerId: z.string().nullable().optional(),
    donateProceeds: z.boolean().optional(),
    hasPrintedTag: z.boolean().optional(),
  })
  .strict();

export const ItemResponseSchema = z.object({
  id: z.string(),
  swapId: z.string(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sku: z.string(),
  priceCents: z.number().int(),
  originalQuantity: z.number().int(),
  inStock: z.number().int(),
  soldCount: z.number().int(),
  squareSynced: z.boolean(),
  donateProceeds: z.boolean(),
  hasPrintedTag: z.boolean(),
  seller: SellerResponseSchema.pick({ id: true, displayName: true, phone: true }).nullable(),
  photos: z.array(z.object({ id: z.string(), url: z.string() })),
});

export class CreateItemDto extends createZodDto(CreateItemSchema) {}
export class PatchItemDto extends createZodDto(PatchItemSchema) {}
export type ItemResponse = z.infer<typeof ItemResponseSchema>;

// ─── Public seller lookup ─────────────────────────────────────────────────────

export const PublicSellerItemSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  priceCents: z.number().int(),
  originalQuantity: z.number().int(),
  inStock: z.number().int(),
  soldCount: z.number().int(),
});

// ─── Business seller invite (admin) ──────────────────────────────────────────

export const InviteBusinessSellerSchema = z
  .object({ businessName: z.string().trim().min(1).max(100), email: z.string().trim().toLowerCase().email() })
  .strict();

/** Removal is soft: the profile row survives as a tombstone. */
export const UpdateBusinessSellerStatusSchema = z
  .object({ removed: z.boolean() })
  .strict();

export const BusinessSellerMemberResponseSchema = z.object({
  userId: z.string(),
  sellerId: z.string(),
  email: z.string().nullable(),
  businessName: z.string().nullable(),
  displayName: z.string(),
  phone: z.string().nullable(),
  joinedAt: z.string().datetime(),
  removedAt: z.string().datetime().nullable(),
});

export class InviteBusinessSellerDto extends createZodDto(InviteBusinessSellerSchema) {}
export class UpdateBusinessSellerStatusDto extends createZodDto(UpdateBusinessSellerStatusSchema) {}
export type BusinessSellerMemberResponse = z.infer<typeof BusinessSellerMemberResponseSchema>;

// ─── Seller self-service ──────────────────────────────────────────────────────

export const SellerSwapSummarySchema = z.object({ id: z.string(), title: z.string() });

export const SellerItemCreateSchema = z
  .object({
    swapId: z.string(),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    priceCents: z.number().int().positive(),
    quantity: z.number().int().positive(),
    donateProceeds: z.boolean().default(false),
    /**
     * Present when the item is being entered at a check-in station: it decides
     * where the tag prints and which counter mints the SKU. Absent for a
     * business seller entering items from their own desk.
     */
    stationId: z.string().optional(),
  })
  .strict();

/** Check-in endpoints all name the pair the station QR encodes. */
export const CheckinContextSchema = z
  .object({ swapId: z.string().min(1), stationId: z.string().min(1) })
  .strict();

/**
 * A contact and nothing else.
 *
 * No name: most sellers are already on the roster, and a name supplied here
 * would be discarded for them — `resolveOrCreate` fills gaps and never
 * overwrites. Asking before we know who this is would also reveal whether a
 * number is already known to the org, which the rest of the auth design goes to
 * some trouble to avoid. The name is settled after the contact is proven, and
 * only when there isn't one.
 */
export const CheckinRegisterSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().optional(),
    phone: z.string().trim().min(7).max(32).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.email) || Boolean(v.phone), {
    message: 'An email address or mobile number is required',
  });

export const ReprintItemSchema = z.object({ stationId: z.string().min(1) }).strict();

export class ReprintItemDto extends createZodDto(ReprintItemSchema) {}
export class CheckinContextDto extends createZodDto(CheckinContextSchema) {}
export class CheckinRegisterDto extends createZodDto(CheckinRegisterSchema) {}

export const SellerItemUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    priceCents: z.number().int().positive().optional(),
    quantity: z.number().int().nonnegative().optional(),
    donateProceeds: z.boolean().optional(),
    hasPrintedTag: z.boolean().optional(),
  })
  .strict();

export class SellerItemCreateDto extends createZodDto(SellerItemCreateSchema) {}
export class SellerItemUpdateDto extends createZodDto(SellerItemUpdateSchema) {}
export type SellerSwapSummary = z.infer<typeof SellerSwapSummarySchema>;

// ─── Printers ─────────────────────────────────────────────────────────────────

export const PAPER_SIZES = ['40x30', '50x30'] as const;
export type PaperSize = typeof PAPER_SIZES[number];

export const CreatePrinterSchema = z
  .object({
    name: z.string().min(1).max(100),
    bluetoothName: z.string().min(1).max(100),
    paperSize: z.enum(PAPER_SIZES),
  })
  .strict();

const MarginFields = {
  marginTop:    z.number().int().min(0).max(160),
  marginBottom: z.number().int().min(0).max(160),
  marginLeft:   z.number().int().min(0).max(160),
  marginRight:  z.number().int().min(0).max(160),
};

export const PatchPrinterSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    bluetoothName: z.string().min(1).max(100).optional(),
    assignedSellerId: z.string().nullable().optional(),
    /** The bridge that drives this printer. Mutually exclusive with a seller. */
    bridgeDeviceId: z.string().nullable().optional(),
    paperSize: z.enum(PAPER_SIZES).optional(),
    ...Object.fromEntries(Object.entries(MarginFields).map(([k, v]) => [k, v.optional()])),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'At least one field must be provided',
  });

export const PatchPrinterPaperSizeSchema = z
  .object({ paperSize: z.enum(PAPER_SIZES) })
  .strict();

export const SwapPrinterResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  bluetoothName: z.string(),
  paperSize: z.enum(PAPER_SIZES),
  marginTop:    z.number().int(),
  marginBottom: z.number().int(),
  marginLeft:   z.number().int(),
  marginRight:  z.number().int(),
  assignedSellerId: z.string().nullable(),
  assignedSellerName: z.string().nullable(),
  /** The bridge that drives this printer, and the station that bridge serves. */
  bridgeDeviceId: z.string().nullable(),
  bridgeName: z.string().nullable(),
  stationName: z.string().nullable(),
});

export class CreatePrinterDto extends createZodDto(CreatePrinterSchema) {}
export class PatchPrinterDto extends createZodDto(PatchPrinterSchema) {}
export class PatchPrinterPaperSizeDto extends createZodDto(PatchPrinterPaperSizeSchema) {}
export type SwapPrinterResponse = z.infer<typeof SwapPrinterResponseSchema>;

// ─── Ski Swap Settings ────────────────────────────────────────────────────────

export const UpdateSkiSwapSettingsSchema = z
  .object({ labelsPerItem: z.number().int().min(1).max(3) })
  .strict();

export const SkiSwapSettingsResponseSchema = z.object({
  labelsPerItem: z.number().int(),
});

export class UpdateSkiSwapSettingsDto extends createZodDto(UpdateSkiSwapSettingsSchema) {}
export type SkiSwapSettingsResponse = z.infer<typeof SkiSwapSettingsResponseSchema>;

// ─── Public seller detail (by ID) ────────────────────────────────────────────

export const PublicSellerDetailItemSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  sku: z.string(),
  priceCents: z.number().int(),
  originalQuantity: z.number().int(),
  inStock: z.number().int(),
  soldCount: z.number().int(),
  donateProceeds: z.boolean(),
});

export const PublicSellerDetailSwapSchema = z.object({
  swapId: z.string(),
  swapTitle: z.string(),
  items: z.array(PublicSellerDetailItemSchema),
});

export const PublicSellerDetailResponseSchema = z.object({
  sellerName: z.string(),
  orgName: z.string(),
  orgLogoUrl: z.string().nullable(),
  swaps: z.array(PublicSellerDetailSwapSchema),
});

export type PublicSellerDetailItem = z.infer<typeof PublicSellerDetailItemSchema>;
export type PublicSellerDetailSwap = z.infer<typeof PublicSellerDetailSwapSchema>;
export type PublicSellerDetailResponse = z.infer<typeof PublicSellerDetailResponseSchema>;

// ─── Public seller find (email + last4) ──────────────────────────────────────

export const SellerFindResponseSchema = z.object({ sellerId: z.string() });
export type SellerFindResponse = z.infer<typeof SellerFindResponseSchema>;


// ─── Check-in stations ───────────────────────────────────────────────────────

export const CreateStationSchema = z.object({ name: z.string().min(1).max(60) }).strict();

export const UpdateStationSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    attendantDeviceId: z.string().nullable().optional(),
    bridgeDeviceId: z.string().nullable().optional(),
  })
  .strict();

export const StationResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  /**
   * Derived from whether a staff tablet is bound, never stored — a flag could
   * disagree with the hardware actually attached.
   */
  kind: z.enum(['staffed', 'self_service']),
  attendantDeviceId: z.string().nullable(),
  attendantName: z.string().nullable(),
  attendantLastSeenAt: z.string().nullable(),
  bridgeDeviceId: z.string().nullable(),
  bridgeName: z.string().nullable(),
  bridgeLastSeenAt: z.string().nullable(),
  /**
   * Reached through the bridge, never bound here: a bridge holds its printer's
   * Bluetooth link continuously, so the bridge is what decides which printer a
   * station prints to.
   */
  printerId: z.string().nullable(),
  printerName: z.string().nullable(),
  createdAt: z.string(),
});

export class CreateStationDto extends createZodDto(CreateStationSchema) {}
export class UpdateStationDto extends createZodDto(UpdateStationSchema) {}
export type StationResponse = z.infer<typeof StationResponseSchema>;

export const StationQueueResponseSchema = z.object({
  stationId: z.string(),
  queued: z.number().int(),
  claimed: z.number().int(),
  /** A recipe that no longer resolves — the item was deleted mid-print. */
  failed: z.number().int(),
  /** Retried to the cap and given up on. */
  abandoned: z.number().int(),
  /** The bridge's last word on its printer link: ready | down, or null. */
  printerLink: z.enum(['ready', 'down']).nullable(),
  printerLinkAt: z.string().nullable(),
  oldestQueuedAt: z.string().nullable(),
  /** The bridge, when one is bound. Null for a staffed station without one. */
  bridgeLastSeenAt: z.string().nullable(),
  /** The staff tablet, when one is bound. What to watch when there is no bridge. */
  attendantLastSeenAt: z.string().nullable(),
});

export type StationQueueResponse = z.infer<typeof StationQueueResponseSchema>;

// ─── Print queue (device-facing) ─────────────────────────────────────────────

export const NackJobSchema = z.object({ error: z.string().max(500).optional() }).strict();

/**
 * What a bridge tells us about itself when it asks for work.
 *
 * On the claim rather than a separate heartbeat, so it costs no extra request
 * on venue wifi. A bridge whose printer is down still claims — with `limit=0`
 * if it has nowhere to put a job — because otherwise a dead printer and a dead
 * bridge look identical from here, and those need different people to fix them.
 */
export const ClaimJobsSchema = z
  .object({ printerLink: z.enum(['ready', 'down']).optional() })
  .strict();

export class ClaimJobsDto extends createZodDto(ClaimJobsSchema) {}

export const ClaimedJobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  seq: z.number().int(),
  /** Base64 ESC/POS, ready to hand straight to the printer over BLE. */
  payload: z.string(),
});

export const ClaimResponseSchema = z.object({
  stationId: z.string(),
  backoffMs: z.number().int(),
  jobs: z.array(ClaimedJobSchema),
});

export class NackJobDto extends createZodDto(NackJobSchema) {}
export type ClaimedJob = z.infer<typeof ClaimedJobSchema>;
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

// ─── Browser-driven label rendering ──────────────────────────────────────────

export const RenderLabelSchema = z
  .object({
    kind: z.enum(['item', 'receipt_header', 'receipt_items', 'qr', 'printer_label', 'calibration']),
    /** `escpos` for a Bluetooth write, `png` for on-screen preview. */
    format: z.enum(['escpos', 'png']).default('escpos'),
    itemId: z.string().optional(),
    sellerId: z.string().optional(),
    swapId: z.string().optional(),
  })
  .strict();

export const RenderLabelResponseSchema = z.object({
  format: z.enum(['escpos', 'png']),
  /** One entry per label; a receipt's item list paginates across several. */
  pages: z.array(z.string()),
});

export class RenderLabelDto extends createZodDto(RenderLabelSchema) {}
export type RenderLabelResponse = z.infer<typeof RenderLabelResponseSchema>;
