import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// ─── Binding indemnification lookup (Plan 44) ────────────────────────────────

/**
 * What the lists say about a binding model, computed when asked (D4):
 * - `indemnified`: on its program's latest list;
 * - `final_season`: on it, and the maker says this is the last season;
 * - `lapsed`: on an earlier season's list, not the latest;
 * - `not_listed`: a model node with no entry ever;
 * - `unavailable`: its only entries are NSSRA-sourced and this patrol hasn't
 *   declared membership (D5). Never "not listed" in that case.
 */
export const INDEMNIFICATION_ANSWERS = ['indemnified', 'final_season', 'lapsed', 'not_listed', 'unavailable'] as const;
export const IndemnificationAnswerSchema = z.enum(INDEMNIFICATION_ANSWERS);
export type IndemnificationAnswer = z.infer<typeof IndemnificationAnswerSchema>;

export const IndemnificationLineSchema = z.enum(['retail', 'rental', 'demo']);
export type IndemnificationLine = z.infer<typeof IndemnificationLineSchema>;

export const IndemnificationProgramRefSchema = z.object({ key: z.string(), name: z.string() });

/** One season's entry, as the detail view lists them. */
export const BindingLookupEntrySchema = z.object({
  season: z.string(),
  status: z.enum(['listed', 'final_season']),
  lines: z.array(IndemnificationLineSchema),
  currentLine: z.boolean().nullable(),
  nonIso: z.boolean(),
  source: z.enum(['nssra', 'manufacturer']),
  sourceRef: z.string().nullable(),
  note: z.string().nullable(),
  program: IndemnificationProgramRefSchema,
});
export type BindingLookupEntry = z.infer<typeof BindingLookupEntrySchema>;

/** A model and its answer: one row of a search or a brand's list. */
export const BindingLookupSchema = z.object({
  nodeId: z.string(),
  manufacturerId: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  answer: IndemnificationAnswerSchema,
  /** The season answered for: the program's latest. Null for not_listed / unavailable. */
  season: z.string().nullable(),
  /** For lapsed: the last season it was on a list. */
  lastListedSeason: z.string().nullable(),
  lines: z.array(IndemnificationLineSchema),
  currentLine: z.boolean().nullable(),
  nonIso: z.boolean(),
  program: IndemnificationProgramRefSchema.nullable(),
  note: z.string().nullable(),
});
export type BindingLookup = z.infer<typeof BindingLookupSchema>;

export const BindingLookupDetailSchema = BindingLookupSchema.extend({
  entries: z.array(BindingLookupEntrySchema),
  programNotes: z.string().nullable(),
  /** Entries this patrol can't see (NSSRA-sourced, membership not declared). */
  hiddenEntries: z.number().int(),
});
export type BindingLookupDetail = z.infer<typeof BindingLookupDetailSchema>;

export const ManufacturerSummarySchema = z.object({
  nodeId: z.string(),
  label: z.string(),
  /** Models under it that this patrol can pick. */
  models: z.number().int(),
  /** Of those, on a program's latest list. */
  listed: z.number().int(),
  programs: z.array(IndemnificationProgramRefSchema),
});
export type ManufacturerSummary = z.infer<typeof ManufacturerSummarySchema>;

export const ManufacturersResponseSchema = z.object({
  /** Whether this patrol sees NSSRA-sourced entries (D5). */
  nssraMember: z.boolean(),
  /** The newest season any program has. Null before the first import. */
  latestSeason: z.string().nullable(),
  manufacturers: z.array(ManufacturerSummarySchema),
});
export type ManufacturersResponse = z.infer<typeof ManufacturersResponseSchema>;

export const LookupSearchQuerySchema = z.object({ q: z.string().max(120).default('') }).strict();
export class LookupSearchQueryDto extends createZodDto(LookupSearchQuerySchema) {}

// ─── Platform administration ─────────────────────────────────────────────────

export const IndemnificationProgramSchema = z.object({
  key: z.string(),
  name: z.string(),
  notes: z.string(),
  latestSeason: z.string().nullable(),
  entries: z.number().int(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});
export type IndemnificationProgram = z.infer<typeof IndemnificationProgramSchema>;

export const PatchIndemnificationProgramSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    notes: z.string().max(20_000).optional(),
  })
  .strict();
export class PatchIndemnificationProgramDto extends createZodDto(PatchIndemnificationProgramSchema) {}

/** "2025-26": a season as the lists and the CSV write it. */
export const SEASON_PATTERN = /^\d{4}-\d{2}$/;

/** A model named by brand and label, in a plan's lists. */
const PlanModelSchema = z.object({ manufacturer: z.string(), model: z.string() });

/**
 * What an import would do, or did (D8). The dry run answers this without
 * writing; the commit answers it with `committed: true` and the import's id.
 */
export const IndemnificationImportPlanSchema = z.object({
  season: z.string().nullable(),
  rows: z.number().int(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
  mintManufacturers: z.array(z.string()),
  mintModels: z.array(PlanModelSchema),
  entries: z.object({ new: z.number().int(), changed: z.number().int(), unchanged: z.number().int() }),
  /** Per program: last season's models missing from the file, about to read lapsed. */
  lapsing: z.array(
    z.object({
      program: IndemnificationProgramRefSchema,
      fromSeason: z.string(),
      toSeason: z.string(),
      models: z.array(PlanModelSchema),
    }),
  ),
  /** The season each program in the file moves to. */
  programs: z.array(z.object({ key: z.string(), season: z.string() })),
  committed: z.boolean(),
  importId: z.string().nullable(),
});
export type IndemnificationImportPlan = z.infer<typeof IndemnificationImportPlanSchema>;

export const IndemnificationImportRecordSchema = z.object({
  id: z.string(),
  season: z.string(),
  fileName: z.string().nullable(),
  counts: z.record(z.unknown()),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
export type IndemnificationImportRecord = z.infer<typeof IndemnificationImportRecordSchema>;

/** Which patrols have declared NSSRA membership (D5). */
export const NssraDeclarationSchema = z.object({
  orgId: z.string(),
  orgName: z.string(),
  nssraMember: z.boolean(),
  setBy: z.string().nullable(),
  setAt: z.string().nullable(),
});
export type NssraDeclaration = z.infer<typeof NssraDeclarationSchema>;
