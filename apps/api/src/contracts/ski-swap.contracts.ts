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
const PAYOUT_ID_TYPES = ['EMAIL', 'PHONE', 'USER_HANDLE'] as const;

// Validates identifier format against the selected type
function validatePayoutIdentifier(
  method: string | undefined,
  idType: string | undefined,
  identifier: string | undefined,
  ctx: z.RefinementCtx,
) {
  if (!method || method === 'DONATE' || method === 'CHECK') return; // no identifier needed
  if (!idType || !identifier) return; // optional overall
  if (idType === 'EMAIL' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
    ctx.addIssue({ code: 'custom', message: `Payout identifier must be a valid email for type EMAIL`, path: ['payoutIdentifier'] });
  }
  if (idType === 'PHONE' && !/^\d{7,}$/.test(identifier.replace(/\D/g, ''))) {
    ctx.addIssue({ code: 'custom', message: `Payout identifier must be a valid phone number for type PHONE`, path: ['payoutIdentifier'] });
  }
}

const PayoutFields = {
  payoutMethod: z.enum(PAYOUT_METHODS).nullable().optional(),
  payoutIdentifierType: z.enum(PAYOUT_ID_TYPES).nullable().optional(),
  payoutIdentifier: z.string().max(200).nullable().optional(),
  payoutIdentifierConfirmedAt: z.string().datetime().nullable().optional(),
};

export const CreateSellerSchema = z
  .object({
    name: z.string().min(1).max(100),
    phone: z.string().min(1).max(20),
    email: z.string().email().optional(),
    type: z.enum(['individual', 'business']).default('individual'),
    street: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(50).optional(),
    zip: z.string().max(20).optional(),
    ...PayoutFields,
  })
  .strict()
  .superRefine((v, ctx) => validatePayoutIdentifier(v.payoutMethod ?? undefined, v.payoutIdentifierType ?? undefined, v.payoutIdentifier ?? undefined, ctx));

export const PatchSellerSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    phone: z.string().min(1).max(20).optional(),
    email: z.string().email().nullable().optional(),
    type: z.enum(['individual', 'business']).optional(),
    street: z.string().max(200).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    state: z.string().max(50).nullable().optional(),
    zip: z.string().max(20).nullable().optional(),
    ...PayoutFields,
  })
  .strict()
  .superRefine((v, ctx) => validatePayoutIdentifier(v.payoutMethod ?? undefined, v.payoutIdentifierType ?? undefined, v.payoutIdentifier ?? undefined, ctx));

export const SellerResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  type: z.enum(['individual', 'business']),
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  payoutMethod: z.enum(PAYOUT_METHODS).nullable(),
  payoutIdentifierType: z.enum(PAYOUT_ID_TYPES).nullable(),
  payoutIdentifier: z.string().nullable(),
  payoutIdentifierConfirmedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export class CreateSellerDto extends createZodDto(CreateSellerSchema) {}
export class PatchSellerDto extends createZodDto(PatchSellerSchema) {}
export type SellerResponse = z.infer<typeof SellerResponseSchema>;

// ─── Items ────────────────────────────────────────────────────────────────────

export const CreateItemSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    priceCents: z.number().int().positive(),
    quantity: z.number().int().positive(),
    sellerId: z.string().optional(),
    donateProceeds: z.boolean().default(false),
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
  seller: SellerResponseSchema.pick({ id: true, name: true, phone: true }).nullable(),
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
  .object({ name: z.string().min(1).max(100), email: z.string().email() })
  .strict();

export const UpdateBusinessSellerStatusSchema = z
  .object({ status: z.enum(['active', 'disabled']) })
  .strict();

export const BusinessSellerMemberResponseSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  status: z.string(),
  joinedAt: z.string().datetime(),
  seller: z
    .object({ id: z.string(), name: z.string(), email: z.string().nullable(), phone: z.string() })
    .nullable(),
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

export const CreatePrinterSchema = z
  .object({
    name: z.string().min(1).max(100),
    bluetoothName: z.string().min(1).max(100),
  })
  .strict();

export const PatchPrinterSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    bluetoothName: z.string().min(1).max(100).optional(),
    assignedSellerId: z.string().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'At least one field must be provided',
  });

export const SwapPrinterResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  bluetoothName: z.string(),
  assignedSellerId: z.string().nullable(),
  assignedSellerName: z.string().nullable(),
});

export class CreatePrinterDto extends createZodDto(CreatePrinterSchema) {}
export class PatchPrinterDto extends createZodDto(PatchPrinterSchema) {}
export type SwapPrinterResponse = z.infer<typeof SwapPrinterResponseSchema>;

