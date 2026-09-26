import { BadRequestException, Injectable, Logger, PayloadTooLargeException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UNPLANNED_RESETS, bootsSince, readReport } from './telemetry-report';

/** The firmware's default, and what a device with no setting of its own is told. */
export const DEFAULT_INTERVAL_S = 300;
/** The range the firmware clamps to. Settings outside it are refused, not clamped. */
export const MIN_INTERVAL_S = 60;
export const MAX_INTERVAL_S = 3600;
/** A real report is around 600 bytes. */
export const MAX_REPORT_BYTES = 4096;

const HOUR = 60 * 60 * 1000;
/** Reports and outages older than this are deleted. */
export const TELEMETRY_RETENTION_MS = 90 * 24 * HOUR;

/**
 * How long a bridge may go without checking in before the gap is an outage.
 * The same two rules the web uses to call a bridge offline
 * (`hardwareStatus.tsx`): four missed heartbeats for a bridge serving a
 * station, and two missed thirty-second retries for one that is not.
 */
export const OFFLINE_AFTER_MS = 20_000;
export const OFFLINE_AFTER_UNBOUND_MS = 70_000;

/**
 * Device telemetry: the reports themselves, and the outages measured from
 * check-ins.
 */
@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);
  private lastPrune = 0;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores one report and tells the device how often to send the next.
   *
   * The body is kept exactly as sent. Only a body that is not an object, or is
   * over the size limit, is refused.
   */
  async ingest(deviceId: string, body: unknown, contentLength?: number): Promise<{ intervalS: number }> {
    const size = contentLength ?? Buffer.byteLength(JSON.stringify(body ?? null));
    if (size > MAX_REPORT_BYTES) {
      throw new PayloadTooLargeException(`A telemetry report may be at most ${MAX_REPORT_BYTES} bytes`);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('A telemetry report must be a JSON object');
    }

    const receivedAt = new Date();
    const { columns, malformed } = readReport(body as Record<string, unknown>);
    const previous = await this.prisma.deviceTelemetry.findFirst({
      where: { deviceId },
      orderBy: { receivedAt: 'desc' },
      select: { bootCount: true, uptimeMs: true },
    });
    const boots = bootsSince(columns, previous && {
      bootCount: previous.bootCount,
      uptimeMs: previous.uptimeMs === null ? null : Number(previous.uptimeMs),
    });

    await this.prisma.deviceTelemetry.create({
      data: {
        deviceId,
        receivedAt,
        body: body as Prisma.InputJsonValue,
        ...(malformed.length ? { malformedFields: malformed } : {}),
        ...columns,
        uptimeMs: columns.uptimeMs === null ? null : BigInt(columns.uptimeMs),
        // The device has no clock of its own; this is when it booted by ours.
        bootAt: columns.uptimeMs === null ? null : new Date(receivedAt.getTime() - columns.uptimeMs),
        bootsSincePrevious: boots,
        unplannedReboot: boots > 0 && columns.resetReason !== null && UNPLANNED_RESETS.has(columns.resetReason),
      },
    });
    if (malformed.length) {
      this.logger.warn({ deviceId, malformed }, 'Telemetry report had known fields of the wrong type');
    }

    await this.pruneNowAndThen();

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { telemetryIntervalS: true },
    });
    return { intervalS: device?.telemetryIntervalS ?? DEFAULT_INTERVAL_S };
  }

  /**
   * Records an outage if this check-in ends one.
   *
   * Called from the claim, with when the bridge was seen before this one. A gap
   * longer than the offline rule is an outage from then until now.
   */
  async recordCheckIn(deviceId: string, previouslySeenAt: Date | null, now: Date, bound: boolean): Promise<void> {
    if (!previouslySeenAt) return;
    const gap = now.getTime() - previouslySeenAt.getTime();
    if (gap <= (bound ? OFFLINE_AFTER_MS : OFFLINE_AFTER_UNBOUND_MS)) return;
    await this.prisma.deviceOutage.create({
      data: { deviceId, startedAt: previouslySeenAt, endedAt: now },
    });
  }

  /** Deletes what is past retention, at most once an hour. */
  private async pruneNowAndThen(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPrune < HOUR) return;
    this.lastPrune = now;
    const before = new Date(now - TELEMETRY_RETENTION_MS);
    try {
      await this.prisma.deviceTelemetry.deleteMany({ where: { receivedAt: { lt: before } } });
      await this.prisma.deviceOutage.deleteMany({ where: { endedAt: { lt: before } } });
    } catch (err) {
      this.logger.error({ err }, 'Could not prune device telemetry');
    }
  }
}
