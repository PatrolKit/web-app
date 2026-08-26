import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** A day is long enough to cover a retry, short enough not to hoard responses. */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Replays the response to a retried write instead of performing it twice.
 *
 * Keys are supplied by the client, so they are namespaced by a caller-supplied
 * `scope` — org and user, in practice. Without it two callers who happened to
 * pick the same key would each receive the other's response: a silent no-op for
 * the second write, and a leak of the first one's contents. Random keys make
 * that unlikely rather than impossible, and "unlikely" is not the guarantee to
 * offer for something a client controls.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async getCached(scope: string, key: string): Promise<Record<string, unknown> | null> {
    const record = await this.prisma.idempotencyRecord.findUnique({
      where: { key: compound(scope, key) },
    });
    if (!record) return null;
    if (record.expiresAt < new Date()) return null;
    return record.response as Record<string, unknown>;
  }

  async save(scope: string, key: string, response: Record<string, unknown>): Promise<void> {
    const expiresAt = new Date(Date.now() + TTL_MS);
    await this.prisma.idempotencyRecord.upsert({
      where: { key: compound(scope, key) },
      create: { key: compound(scope, key), response: response as Prisma.InputJsonValue, expiresAt },
      update: { response: response as Prisma.InputJsonValue, expiresAt },
    });
  }
}

function compound(scope: string, key: string): string {
  return `${scope}:${key}`;
}
