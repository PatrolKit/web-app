import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { SkiSwapSettingsResponse } from '../contracts/ski-swap.contracts';

const DEFAULT_LABELS_PER_ITEM = 1;

@Injectable()
export class SkiSwapSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(orgId: string): Promise<SkiSwapSettingsResponse> {
    const row = await this.prisma.skiSwapSettings.findUnique({ where: { orgId } });
    return { labelsPerItem: row?.labelsPerItem ?? DEFAULT_LABELS_PER_ITEM };
  }

  async upsert(orgId: string, labelsPerItem: number): Promise<SkiSwapSettingsResponse> {
    const row = await this.prisma.skiSwapSettings.upsert({
      where: { orgId },
      update: { labelsPerItem },
      create: { orgId, labelsPerItem },
    });
    return { labelsPerItem: row.labelsPerItem };
  }
}
