import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async getCached(key: string): Promise<Record<string, unknown> | null> {
    const record = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
    if (!record) return null;
    if (record.expiresAt < new Date()) return null;
    return record.response as Record<string, unknown>;
  }

  async save(key: string, response: Record<string, unknown>): Promise<void> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await this.prisma.idempotencyRecord.upsert({
      where: { key },
      create: { key, response: response as Prisma.InputJsonValue, expiresAt },
      update: { response: response as Prisma.InputJsonValue, expiresAt },
    });
  }
}
