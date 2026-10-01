import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { displayName } from '../common/util/person';
import type { PlatformSettingsResponse } from '../contracts/platform-settings.contracts';

type Settings = { smsEnabled: boolean; updatedAt: Date; updatedById: string | null };

/** The row its migration inserts; read as this if it has somehow gone. */
const DEFAULTS: Settings = { smsEnabled: false, updatedAt: new Date(0), updatedById: null };

/**
 * Platform-wide settings (Plan 29): one row, read on nearly every request that
 * might text, so held in memory.
 *
 * The API runs as one process, so `update` refreshing the cache is all it
 * takes for every caller to see a change at once.
 */
@Injectable()
export class PlatformSettingsService {
  private cached: Settings | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async get(): Promise<Settings> {
    if (!this.cached) {
      this.cached = (await this.prisma.platformSettings.findUnique({ where: { id: 1 } })) ?? DEFAULTS;
    }
    return this.cached;
  }

  async smsEnabled(): Promise<boolean> {
    return (await this.get()).smsEnabled;
  }

  async update(data: { smsEnabled: boolean }, userId: string): Promise<Settings> {
    this.cached = await this.prisma.platformSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...data, updatedById: userId },
      update: { ...data, updatedById: userId },
    });
    return this.cached;
  }

  /** The Configuration tab's view: the switch, who moved it, and whether texts would leave. */
  async describe(): Promise<PlatformSettingsResponse> {
    const settings = await this.get();
    const by = settings.updatedById
      ? await this.prisma.user.findUnique({
          where: { id: settings.updatedById },
          select: { firstName: true, lastName: true, email: true, phone: true },
        })
      : null;
    return {
      smsEnabled: settings.smsEnabled,
      updatedAt: settings.updatedAt.toISOString(),
      updatedBy: by ? displayName(by) : null,
      smsReadiness: {
        originationNumber: !!this.config.get<string>('app.snsOriginationNumber', ''),
        outboundNotifications: !!this.config.get<boolean>('app.outboundNotifications', false),
      },
    };
  }
}
