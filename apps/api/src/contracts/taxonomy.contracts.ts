import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { TAXONOMY_ICON_KEYS } from './taxonomy-icons';

export { TAXONOMY_ICON_KEYS, isTaxonomyIconKey } from './taxonomy-icons';
export type { TaxonomyIconKey } from './taxonomy-icons';

// ─── The resolved tree (Plan 19 §4) ──────────────────────────────────────────

/**
 * A node's icon, absent when it has none.
 *
 * Discriminated rather than two optional fields, so a renderer cannot forget to
 * check the second one.
 */
export const ResolvedIconSchema = z.discriminatedUnion('kind', [
  /**
   * A built-in mark. Carries both a key and a URL, because the two clients
   * cannot use the same one.
   *
   * `key` is what the web reads: it resolves against the bundle, costs no
   * request and inherits the surrounding text colour. `url` serves the same
   * glyph as a 128×128 PNG, monochrome with alpha, for a native client that has
   * no bundle to resolve against — iOS draws it as a template image, taking the
   * shape from the alpha channel and the colour from the view, which is the same
   * property by different means.
   *
   * The alternative for iOS was a hand-written map from every key to a Font
   * Awesome codepoint in a shipped font, which goes stale the moment the
   * registry grows and needs an App Store release to catch up — precisely the
   * failure the uploaded-icon path exists to avoid.
   */
  z.object({
    kind: z.literal('registry'),
    key: z.enum(TAXONOMY_ICON_KEYS),
    url: z.string(),
  }),
  /**
   * An uploaded image. Drawn as it is — a club's logo is a picture, not a mark,
   * so a native client must not tint it. That difference is why `kind` earns its
   * place rather than collapsing into a single `url`.
   */
  z.object({ kind: z.literal('image'), url: z.string() }),
]);

export const TaxonomyScopeSchema = z.enum(['global', 'org']);

/**
 * Declared with `z.lazy` because an attribute holds values and a value holds
 * attributes — the recursion the tree is made of. Zod cannot infer a type
 * through that, so the interfaces below are written by hand and the schemas
 * annotated with them.
 */
export interface ResolvedAttribute {
  id: string;
  label: string;
  icon?: z.infer<typeof ResolvedIconSchema>;
  scope: 'global' | 'org';
  input: 'select' | 'number';
  displayOrder: number;
  /** Position in the derived name, ascending. Null ⇒ not named. */
  nameSlot: number | null;
  allowFreeEntry?: boolean;
  values?: ResolvedValue[];
  /** True ⇒ `values` is absent and must be fetched. */
  valuesDeferred?: boolean;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface ResolvedValue {
  id: string;
  label: string;
  icon?: z.infer<typeof ResolvedIconSchema>;
  scope: 'global' | 'org';
  displayOrder: number;
  /** Questions that appear only once this value is chosen. Empty for a leaf. */
  attributes: ResolvedAttribute[];
}

export const ResolvedValueSchema: z.ZodType<ResolvedValue> = z.lazy(() =>
  z.object({
    id: z.string(),
    label: z.string(),
    icon: ResolvedIconSchema.optional(),
    scope: TaxonomyScopeSchema,
    displayOrder: z.number().int(),
    attributes: z.array(ResolvedAttributeSchema),
  }),
);

export const ResolvedAttributeSchema: z.ZodType<ResolvedAttribute> = z.lazy(() =>
  z.object({
    id: z.string(),
    label: z.string(),
    icon: ResolvedIconSchema.optional(),
    scope: TaxonomyScopeSchema,
    input: z.enum(['select', 'number']),
    displayOrder: z.number().int(),
    nameSlot: z.number().int().nullable(),
    allowFreeEntry: z.boolean().optional(),
    values: z.array(ResolvedValueSchema).optional(),
    valuesDeferred: z.boolean().optional(),
    unit: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
  }),
);

export const ResolvedCategorySchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: ResolvedIconSchema.optional(),
  scope: TaxonomyScopeSchema,
  displayOrder: z.number().int(),
  attributes: z.array(ResolvedAttributeSchema),
});

export const ResolvedTaxonomySchema = z.object({
  /** Matches `SkiSwapSettings.taxonomyVersion`. The client's cache key. */
  version: z.number().int(),
  categories: z.array(ResolvedCategorySchema),
});

export type ResolvedIcon = z.infer<typeof ResolvedIconSchema>;
export type ResolvedCategory = z.infer<typeof ResolvedCategorySchema>;
export type ResolvedTaxonomy = z.infer<typeof ResolvedTaxonomySchema>;

/** A deferred branch: whichever kind the node's children are. */
export const TaxonomyChildrenResponseSchema = z.object({
  nodeId: z.string(),
  attributes: z.array(ResolvedAttributeSchema).optional(),
  values: z.array(ResolvedValueSchema).optional(),
});
export type TaxonomyChildrenResponse = z.infer<typeof TaxonomyChildrenResponseSchema>;

// ─── Editing the tree ────────────────────────────────────────────────────────

/**
 * How much of the tree to send.
 *
 * `partial` is the default and what the browser wants: a value's model lists
 * arrive as `valuesDeferred` stubs and are fetched when their control is opened.
 * `full` resolves every branch inline for a client that prefetches — an iPad
 * that syncs at the start of a shift and may not see the network again.
 */
export const TaxonomyDepthQuerySchema = z
  .object({ depth: z.enum(['partial', 'full']).default('partial') })
  .strict();

export class TaxonomyDepthQueryDto extends createZodDto(TaxonomyDepthQuerySchema) {}

export const TaxonomyKindSchema = z.enum(['CATEGORY', 'ATTRIBUTE', 'VALUE']);
export const TaxonomyInputSchema = z.enum(['SELECT', 'NUMBER']);

export const CreateTaxonomyNodeSchema = z
  .object({
    kind: TaxonomyKindSchema,
    /** Null or absent only for a CATEGORY. */
    parentId: z.string().optional(),
    label: z.string().min(1).max(120),
    iconKey: z.enum(TAXONOMY_ICON_KEYS).nullable().optional(),
    displayOrder: z.number().int().optional(),

    // ATTRIBUTE only
    input: TaxonomyInputSchema.optional(),
    nameSlot: z.number().int().nullable().optional(),
    unit: z.string().max(12).nullable().optional(),
    minValue: z.number().nullable().optional(),
    maxValue: z.number().nullable().optional(),
    step: z.number().positive().nullable().optional(),
    allowFreeEntry: z.boolean().optional(),
  })
  .strict();

export const PatchTaxonomyNodeSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    /**
     * Setting a key clears any uploaded image. `iconUrl` is never patchable —
     * a client that could set it directly could point a node at anything, so
     * the upload routes own those columns.
     */
    iconKey: z.enum(TAXONOMY_ICON_KEYS).nullable().optional(),
    displayOrder: z.number().int().optional(),
    nameSlot: z.number().int().nullable().optional(),
    unit: z.string().max(12).nullable().optional(),
    minValue: z.number().nullable().optional(),
    maxValue: z.number().nullable().optional(),
    step: z.number().positive().nullable().optional(),
    allowFreeEntry: z.boolean().optional(),
    /** True approves a PENDING value. False is not a thing: un-approving is a merge or a retire. */
    approve: z.literal(true).optional(),
    /** True retires, false un-retires. */
    retired: z.boolean().optional(),
  })
  .strict();

export const MergeTaxonomyNodeSchema = z.object({ targetId: z.string().min(1) }).strict();

/**
 * One group's intended order, as a list of node ids.
 *
 * Ids rather than id/order pairs: the caller is stating a sequence, and letting
 * it also choose the numbers invites two clients disagreeing about the spacing.
 * The server assigns 10, 20, 30… which is what the seed does and what keeps a
 * later insertion cheap.
 *
 * One request rather than one per row, because reordering is one act. Done a row
 * at a time, sorting thirty-seven manufacturers took fourteen seconds and bumped
 * every org's taxonomy version thirty-seven times.
 */
export const ReorderTaxonomySchema = z
  .object({ order: z.array(z.string().min(1)).min(1).max(500) })
  .strict();

/** Staff minting a value explicitly, rather than a seller typing one mid-item. */
export const CreateTaxonomyValueSchema = z
  .object({
    attributeId: z.string().min(1),
    label: z.string().min(1).max(120),
    /** Approved straight away when staff added it deliberately. */
    approved: z.boolean().default(true),
  })
  .strict();

export class CreateTaxonomyNodeDto extends createZodDto(CreateTaxonomyNodeSchema) {}
export class PatchTaxonomyNodeDto extends createZodDto(PatchTaxonomyNodeSchema) {}
export class MergeTaxonomyNodeDto extends createZodDto(MergeTaxonomyNodeSchema) {}
export class ReorderTaxonomyDto extends createZodDto(ReorderTaxonomySchema) {}
export class CreateTaxonomyValueDto extends createZodDto(CreateTaxonomyValueSchema) {}

// ─── Administration responses ────────────────────────────────────────────────

/**
 * A node as an administrator sees it: everything the editor can change, plus
 * the two counts that decide what the queue lets them do.
 */
export interface TaxonomyAdminNode {
  id: string;
  kind: 'CATEGORY' | 'ATTRIBUTE' | 'VALUE';
  orgId: string | null;
  parentId: string | null;
  label: string;
  /** "Skis › Manufacturer", for a queue row that has to say where a value sits. */
  path: string;
  iconKey: string | null;
  iconUrl: string | null;
  status: 'APPROVED' | 'PENDING';
  displayOrder: number;
  retiredAt: string | null;
  input: 'SELECT' | 'NUMBER' | null;
  nameSlot: number | null;
  unit: string | null;
  minValue: number | null;
  maxValue: number | null;
  step: number | null;
  allowFreeEntry: boolean;
  suggestedAt: string | null;
  createdAt: string;
  /**
   * How many items point at this node. What disables Discard: a value in use
   * cannot be deleted, and the count is the reason rather than a constraint
   * error after the click.
   */
  itemCount: number;
  /** Children, for an editor that renders a tree rather than a list. */
  children?: TaxonomyAdminNode[];
}

export const TaxonomyAdminNodeSchema: z.ZodType<TaxonomyAdminNode> = z.lazy(() => z.object({
  id: z.string(),
  kind: TaxonomyKindSchema,
  orgId: z.string().nullable(),
  parentId: z.string().nullable(),
  label: z.string(),
  /** "Skis › Manufacturer", for a queue row that has to say where a value sits. */
  path: z.string(),
  iconKey: z.string().nullable(),
  iconUrl: z.string().nullable(),
  status: z.enum(['APPROVED', 'PENDING']),
  displayOrder: z.number().int(),
  retiredAt: z.string().datetime().nullable(),
  input: TaxonomyInputSchema.nullable(),
  nameSlot: z.number().int().nullable(),
  unit: z.string().nullable(),
  minValue: z.number().nullable(),
  maxValue: z.number().nullable(),
  step: z.number().nullable(),
  allowFreeEntry: z.boolean(),
  suggestedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  /**
   * How many items point at this node. What disables Discard: a value in use
   * cannot be deleted, and the count is the reason rather than a constraint
   * error after the click.
   */
  itemCount: z.number().int(),
  /** Children, for an editor that renders a tree rather than a list. */
  children: z.array(TaxonomyAdminNodeSchema).optional(),
}));

/** A pending value with the near-match that would make it a merge instead. */
export const PendingValueSchema = z.object({
  node: TaxonomyAdminNodeSchema,
  /**
   * An approved value with the same normalised label elsewhere in this org's
   * resolved tree. Present ⇒ the queue offers "Use that instead".
   */
  similar: z
    .object({ id: z.string(), label: z.string(), scope: TaxonomyScopeSchema })
    .nullable(),
});
export type PendingValue = z.infer<typeof PendingValueSchema>;

export const OrgTaxonomyAdminSchema = z.object({
  version: z.number().int(),
  pending: z.array(PendingValueSchema),
  /** This org's own approved nodes. */
  own: z.array(TaxonomyAdminNodeSchema),
});
export type OrgTaxonomyAdmin = z.infer<typeof OrgTaxonomyAdminSchema>;

/** One suggestion in the platform promotion inbox. */
export const TaxonomySuggestionSchema = z.object({
  node: TaxonomyAdminNodeSchema,
  orgName: z.string(),
  /** Whether every ancestor is already global, so promotion is a single step. */
  ancestorsGlobal: z.boolean(),
  /** An existing global node this would merge into rather than join. */
  collision: z.object({ id: z.string(), label: z.string() }).nullable(),
});
export type TaxonomySuggestion = z.infer<typeof TaxonomySuggestionSchema>;
