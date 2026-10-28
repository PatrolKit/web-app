import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// ─── Shared enums ─────────────────────────────────────────────────────────────

export const DUTY_TYPES = ['patrol', 'training', 'instruction', 'other'] as const;
export const DutyTypeSchema = z.enum(DUTY_TYPES);
export type DutyType = z.infer<typeof DutyTypeSchema>;

export const CLOCK_EVENT_TYPES = ['clock_in', 'clock_out'] as const;
export const ClockEventTypeSchema = z.enum(CLOCK_EVENT_TYPES);

export const EVENT_SOURCES = ['device', 'device_auto', 'admin'] as const;
export const EventSourceSchema = z.enum(EVENT_SOURCES);

/**
 * Set by the fold (§5.5), except `rejected` (refused on arrival) and `voided` (a close an
 * admin set aside by reopening its entry, Plan 55 D2). The iPad treats every status but
 * `rejected` as accepted.
 */
export const EVENT_STATUSES = ['applied', 'duplicate', 'orphan', 'anomalous', 'rejected', 'voided'] as const;

export const ENTRY_CLOSE_REASONS = ['manual', 'auto', 'superseded', 'admin'] as const;

// ─── Patrollers (the roster) ─────────────────────────────────────────────────

// ─── The roster: the org's members, read-only here (Plan 57) ─────────────────

export const PatrollerResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string(),
  nspId: z.string(),
  patrolLevel: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  /// True once the person has proved control of either contact channel.
  contactVerified: z.boolean(),
  active: z.boolean(),
  deletedAt: z.string().nullable(),
  updatedAt: z.string(),
});

/**
 * A patroller as a terminal gets it (Plan 55 D10): no contact details. The iPad matches
 * on name and NSP ID, and has no use for anyone's email or phone.
 */
export const DevicePatrollerResponseSchema = PatrollerResponseSchema.omit({
  email: true,
  phone: true,
  contactVerified: true,
}).extend({
  /// The PIN a member with no NSP ID clocks in with (Plan 57 D7); null for
  /// everyone with an NSP ID, and for anyone who hasn't chosen one.
  clockPin: z.string().nullable(),
});

/** `walk=true` on the roster (D7): a page of a keyset walk, with the cursor to keep. */
export const PatrollerWalkResponseSchema = z.object({
  patrollers: z.array(PatrollerResponseSchema.or(DevicePatrollerResponseSchema)),
  /** Taken before the read: the `updatedSince` to send next time, once the last page lands. */
  syncedAt: z.string(),
  /** Absent on the last page. */
  nextAfter: z.string().optional(),
});

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const instant = z.string().datetime({ offset: true, message: 'Must be an ISO date and time' });
/** A season by its start year (D12). */
const seasonYear = z.coerce.number().int().min(2000).max(2100);

export const PatrollerListQuerySchema = z
  .object({
    updatedSince: instant.optional(),
    walk: bool.optional(),
    after: z.string().max(400).optional(),
  })
  .strict();

export class PatrollerListQueryDto extends createZodDto(PatrollerListQuerySchema) {}
export type PatrollerResponse = z.infer<typeof PatrollerResponseSchema>;
export type DevicePatrollerResponse = z.infer<typeof DevicePatrollerResponseSchema>;

// ─── Settings ────────────────────────────────────────────────────────────────

export const UpdateTimeClockSettingsSchema = z
  .object({
    autoCloseLocalTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:mm')
      .optional(),
    autoCloseAfterHours: z.number().int().min(1).max(24).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const TimeClockSettingsResponseSchema = z.object({
  orgId: z.string(),
  autoCloseLocalTime: z.string(),
  autoCloseAfterHours: z.number(),
  updatedAt: z.string(),
});

export class UpdateTimeClockSettingsDto extends createZodDto(UpdateTimeClockSettingsSchema) {}
export type TimeClockSettingsResponse = z.infer<typeof TimeClockSettingsResponseSchema>;

// ─── Clock events (device → server) ──────────────────────────────────────────

/**
 * A duty note is only meaningful on a clock_in with dutyType 'other' (D12); anything
 * else is rejected rather than silently dropped, so a device bug surfaces immediately.
 */
export const ClockEventSchema = z
  .object({
    id: z.string().min(1).max(120),
    resortId: z.string().min(1),
    patrollerId: z.string().min(1),
    /// Accepted for older builds and ignored: a device speaks only for itself (Plan 55 D3).
    deviceId: z.string().nullable().optional(),
    type: ClockEventTypeSchema,
    dutyType: DutyTypeSchema.nullable().optional(),
    dutyNote: z.string().max(120).nullable().optional(),
    source: EventSourceSchema.default('device'),
    occurredAt: z.string().datetime({ offset: true }),
    clockSkewMs: z.number().int().nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type === 'clock_in' && !v.dutyType) {
      ctx.addIssue({ code: 'custom', message: 'clock_in requires a dutyType', path: ['dutyType'] });
    }
    if (v.type === 'clock_out' && v.dutyType) {
      ctx.addIssue({ code: 'custom', message: 'clock_out must not carry a dutyType', path: ['dutyType'] });
    }
    if (v.dutyNote && v.dutyType !== 'other') {
      ctx.addIssue({
        code: 'custom',
        message: "dutyNote is only allowed when dutyType is 'other'",
        path: ['dutyNote'],
      });
    }
  });

export const SubmitEventsSchema = z
  .object({ events: z.array(ClockEventSchema).min(1).max(500) })
  .strict();

export const EventResultSchema = z.object({
  id: z.string(),
  status: z.enum(EVENT_STATUSES),
  note: z.string().nullable().optional(),
});

export class SubmitEventsDto extends createZodDto(SubmitEventsSchema) {}
export type ClockEventInput = z.infer<typeof ClockEventSchema>;
export type EventResult = z.infer<typeof EventResultSchema>;

// ─── Entries ──────────────────────────────────────────────────────────────────

/**
 * No `nspId` (Plan 55 D10): it is the clock-in verifier, and nothing that reads an entry
 * needs it. The hours report, an admin export, keeps it.
 */
export const TimeEntryResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  resortId: z.string(),
  resortName: z.string().nullable(),
  patrollerId: z.string(),
  patrollerName: z.string().nullable(),
  patrolLevel: z.string().nullable(),
  dutyType: z.string(),
  dutyNote: z.string().nullable(),
  clockInAt: z.string(),
  clockOutAt: z.string().nullable(),
  status: z.string(),
  closeReason: z.string().nullable(),
  flagged: z.boolean(),
  /** Corrected by staff at least once; the history says how (D11). */
  edited: z.boolean(),
  /** Only ever set in a delta (`updatedSince`): the device drops its copy (D6). */
  deletedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export const ENTRY_STATUSES = ['open', 'closed'] as const;

export const TimeEntryListQuerySchema = z
  .object({
    resortId: z.string().max(64).optional(),
    status: z.enum(ENTRY_STATUSES).optional(),
    dutyType: DutyTypeSchema.optional(),
    from: instant.optional(),
    to: instant.optional(),
    season: seasonYear.optional(),
    flagged: bool.optional(),
    pastSweep: bool.optional(),
    updatedSince: instant.optional(),
    /** A device's delta, as a keyset walk (D7). */
    walk: bool.optional(),
    after: z.string().max(400).optional(),
    /** A screen's page. */
    skip: z.coerce.number().int().min(0).optional(),
    take: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

/** `walk` or `take` (D7). Without either, the list is a bare array, for older iPads. */
export const TimeEntryPageResponseSchema = z.object({
  entries: z.array(TimeEntryResponseSchema),
  total: z.number(),
  syncedAt: z.string(),
  nextAfter: z.string().optional(),
});

/** Everything that happened to one entry, oldest first (D11). */
export const TimeEntryHistoryResponseSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      source: z.string(),
      status: z.string(),
      statusNote: z.string().nullable(),
      occurredAt: z.string(),
      recordedAt: z.string(),
      deviceName: z.string().nullable(),
    }),
  ),
  changes: z.array(
    z.object({
      action: z.string(),
      actorName: z.string().nullable(),
      at: z.string(),
      before: z.record(z.string(), z.unknown()).nullable(),
      after: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
});

export const PatchTimeEntrySchema = z
  .object({
    clockInAt: z.string().datetime({ offset: true }).optional(),
    clockOutAt: z.string().datetime({ offset: true }).nullable().optional(),
    dutyType: DutyTypeSchema.optional(),
    dutyNote: z.string().max(120).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export class PatchTimeEntryDto extends createZodDto(PatchTimeEntrySchema) {}
export class TimeEntryListQueryDto extends createZodDto(TimeEntryListQuerySchema) {}
export type TimeEntryListQuery = z.infer<typeof TimeEntryListQuerySchema>;
export type TimeEntryResponse = z.infer<typeof TimeEntryResponseSchema>;
export type TimeEntryPageResponse = z.infer<typeof TimeEntryPageResponseSchema>;
export type TimeEntryHistoryResponse = z.infer<typeof TimeEntryHistoryResponseSchema>;

// ─── Reports ─────────────────────────────────────────────────────────────────

export const HoursReportRowSchema = z.object({
  patrollerId: z.string(),
  patrollerName: z.string(),
  nspId: z.string(),
  patrolLevel: z.string().nullable(),
  entryCount: z.number(),
  totalMinutes: z.number(),
  minutesByDutyType: z.record(z.string(), z.number()),
});

export const HoursReportQuerySchema = z
  .object({
    from: instant.optional(),
    to: instant.optional(),
    season: seasonYear.optional(),
    resortId: z.string().max(64).optional(),
    dutyType: DutyTypeSchema.optional(),
  })
  .strict();

export class HoursReportQueryDto extends createZodDto(HoursReportQuerySchema) {}
export type HoursReportQuery = z.infer<typeof HoursReportQuerySchema>;
export type HoursReportRow = z.infer<typeof HoursReportRowSchema>;

// ─── Seasons (Plan 55 D12) ──────────────────────────────────────────────────

export const SeasonSchema = z.object({
  startYear: z.number(),
  label: z.string(),
  /** Inclusive calendar dates, `YYYY-MM-DD`. */
  startsOn: z.string(),
  endsOn: z.string(),
});

export const SeasonsResponseSchema = z.object({
  cutover: z.string(),
  current: SeasonSchema,
  /** From the earliest entry's season to the current one, newest first. */
  seasons: z.array(SeasonSchema),
});

export type Season = z.infer<typeof SeasonSchema>;
export type SeasonsResponse = z.infer<typeof SeasonsResponseSchema>;

// ─── Health (Plan 55 D13) ───────────────────────────────────────────────────

export const TimeClockHealthResponseSchema = z.object({
  /** Events the fold did not apply in the last 30 days, newest first. */
  unapplied: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      status: z.string(),
      statusNote: z.string().nullable(),
      occurredAt: z.string(),
      recordedAt: z.string(),
      patrollerName: z.string().nullable(),
      resortName: z.string().nullable(),
      deviceName: z.string().nullable(),
    }),
  ),
  terminals: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      resortName: z.string().nullable(),
      lastSeenAt: z.string().nullable(),
      appVersion: z.string().nullable(),
    }),
  ),
  /** Events whose resort is not where their terminal was bound (D4), last 30 days. */
  mismatches: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      occurredAt: z.string(),
      patrollerName: z.string().nullable(),
      resortName: z.string().nullable(),
      boundResortName: z.string().nullable(),
      deviceName: z.string().nullable(),
    }),
  ),
  stillOpenPastSweep: z.number(),
  /** Active members with neither an NSP ID nor a PIN, who the iPad can't verify (Plan 57). */
  membersCantClockIn: z.number(),
});

export type TimeClockHealthResponse = z.infer<typeof TimeClockHealthResponseSchema>;
