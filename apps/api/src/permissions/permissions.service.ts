import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface CacheEntry {
  keys: string[];
  exp: number;
}

@Injectable()
export class PermissionsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = 5_000;

  constructor(private readonly prisma: PrismaService) {}

  async getPermissions(userId: string, orgId: string): Promise<string[]> {
    const cacheKey = `${userId}:${orgId}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() < hit.exp) return hit.keys;

    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      include: { permissions: { include: { permission: true } } },
    });

    // A soft-removed membership grants nothing, but the row survives as a tombstone.
    const keys =
      membership && membership.deletedAt === null
        ? membership.permissions.map((mp) => mp.permission.key)
        : [];

    this.cache.set(cacheKey, { keys, exp: Date.now() + this.ttlMs });
    return keys;
  }

  invalidate(userId: string, orgId: string): void {
    this.cache.delete(`${userId}:${orgId}`);
  }
}
