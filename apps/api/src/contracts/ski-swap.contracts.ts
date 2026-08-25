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
  })
  .strict();

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

