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

/** applied | duplicate | orphan | anomalous | rejected — set by the fold (§5.5). */
export const EVENT_STATUSES = ['applied', 'duplicate', 'orphan', 'anomalous', 'rejected'] as const;

export const SHIFT_CLOSE_REASONS = ['manual', 'auto', 'superseded', 'admin'] as const;

// ─── Patrollers (the roster) ─────────────────────────────────────────────────

export const CreatePatrollerSchema = z
  .object({
    firstName: z.string().min(1).max(60),
    lastName: z.string().min(1).max(60),
    nspId: z.string().min(1).max(32),
    patrolLevel: z.string().max(60).nullable().optional(),
    active: z.boolean().default(true),
  })
  .strict();

export const PatchPatrollerSchema = z
  .object({
    firstName: z.string().min(1).max(60).optional(),
    lastName: z.string().min(1).max(60).optional(),
    nspId: z.string().min(1).max(32).optional(),
    patrolLevel: z.string().max(60).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const PatrollerResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string(),
  nspId: z.string(),
  patrolLevel: z.string().nullable(),
  active: z.boolean(),
  deletedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export const ImportPatrollersSchema = z
  .object({
    rows: z
      .array(
        z.object({
          firstName: z.string(),
          lastName: z.string(),
          nspId: z.string(),
          patrolLevel: z.string().nullable().optional(),
        }),
      )
      .max(5000),
    strategy: z.enum(['preserve', 'overwrite']).default('preserve'),
  })
  .strict();

export class CreatePatrollerDto extends createZodDto(CreatePatrollerSchema) {}
export class PatchPatrollerDto extends createZodDto(PatchPatrollerSchema) {}
export class ImportPatrollersDto extends createZodDto(ImportPatrollersSchema) {}
export type PatrollerResponse = z.infer<typeof PatrollerResponseSchema>;

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

// ─── Shifts ──────────────────────────────────────────────────────────────────

export const ShiftResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  resortId: z.string(),
  resortName: z.string().nullable(),
  patrollerId: z.string(),
  patrollerName: z.string().nullable(),
  patrolLevel: z.string().nullable(),
  nspId: z.string().nullable(),
  dutyType: z.string(),
  dutyNote: z.string().nullable(),
  clockInAt: z.string(),
  clockOutAt: z.string().nullable(),
  status: z.string(),
  closeReason: z.string().nullable(),
  flagged: z.boolean(),
  updatedAt: z.string(),
});

export const PatchShiftSchema = z
  .object({
    clockInAt: z.string().datetime({ offset: true }).optional(),
    clockOutAt: z.string().datetime({ offset: true }).nullable().optional(),
    dutyType: DutyTypeSchema.optional(),
    dutyNote: z.string().max(120).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export class PatchShiftDto extends createZodDto(PatchShiftSchema) {}
export type ShiftResponse = z.infer<typeof ShiftResponseSchema>;

// ─── Reports ─────────────────────────────────────────────────────────────────

export const HoursReportRowSchema = z.object({
  patrollerId: z.string(),
  patrollerName: z.string(),
  nspId: z.string(),
  patrolLevel: z.string().nullable(),
  shiftCount: z.number(),
  totalMinutes: z.number(),
  minutesByDutyType: z.record(z.string(), z.number()),
});

export type HoursReportRow = z.infer<typeof HoursReportRowSchema>;
