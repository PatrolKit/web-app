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

export const CreateSellerSchema = z
  .object({
    name: z.string().min(1).max(100),
    phone: z.string().min(1).max(20),
    email: z.string().email().optional(),
    street: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(50).optional(),
    zip: z.string().max(20).optional(),
  })
  .strict();

export const PatchSellerSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    phone: z.string().min(1).max(20).optional(),
    email: z.string().email().nullable().optional(),
    street: z.string().max(200).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    state: z.string().max(50).nullable().optional(),
    zip: z.string().max(20).nullable().optional(),
  })
  .strict();

export const SellerResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
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
  })
  .strict();

export const PatchItemSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    priceCents: z.number().int().positive().optional(),
    quantity: z.number().int().nonnegative().optional(),
    sellerId: z.string().nullable().optional(),
  })
  .strict();

export const ItemResponseSchema = z.object({
  squareItemId: z.string(),
  squareVariationId: z.string(),
  swapId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sku: z.string(),
  priceCents: z.number().int(),
  inStock: z.number().int(),
  soldCount: z.number().int(),
  seller: SellerResponseSchema.pick({ id: true, name: true, phone: true }).nullable(),
  squareImageIds: z.array(z.string()),
});

export class CreateItemDto extends createZodDto(CreateItemSchema) {}
export class PatchItemDto extends createZodDto(PatchItemSchema) {}
export type ItemResponse = z.infer<typeof ItemResponseSchema>;

// ─── Seller–item assignment ───────────────────────────────────────────────────

export const AssignSellerSchema = z.object({ sellerId: z.string().min(1) }).strict();
export class AssignSellerDto extends createZodDto(AssignSellerSchema) {}

