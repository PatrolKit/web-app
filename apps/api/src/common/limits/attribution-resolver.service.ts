import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestAttribution } from './request-attribution';

/** How many ids each cache holds before it starts again. */
const CACHE_LIMIT = 10_000;

export interface ResolvedAttribution {
  /** `''` for platform-wide. */
  orgId: string;
  /** `''` when the request was not about one swap. */
  swapId: string;
}

/**
 * Turns what a request claims it is about into ids that exist.
 *
 * The ids come from the path, so they are whatever the caller typed. Recording
 * them unchecked would let anybody fill the health table with rows for orgs
 * that do not exist, so an id that does not resolve is dropped and the request
 * is recorded as platform-wide.
 *
 * Cached, misses included, because this runs on every request: one primary-key
 * read per id the first time it is seen, and none after.
 */
@Injectable()
export class AttributionResolver {
  private readonly swapOrg = new Map<string, string | null>();
  private readonly orgIds = new Map<string, boolean>();
  private readonly slugOrg = new Map<string, string | null>();

  constructor(private readonly prisma: PrismaService) {}

  async resolve(claimed: RequestAttribution & { orgSlug?: string }): Promise<ResolvedAttribution> {
    // A swap names its org, and outranks whatever else the path says.
    if (claimed.swapId) {
      const orgId = await this.orgOfSwap(claimed.swapId);
      if (orgId) return { orgId, swapId: claimed.swapId };
    }
    if (claimed.orgId && (await this.orgExists(claimed.orgId))) {
      return { orgId: claimed.orgId, swapId: '' };
    }
    if (claimed.orgSlug) {
      const orgId = await this.orgOfSlug(claimed.orgSlug);
      if (orgId) return { orgId, swapId: '' };
    }
    return { orgId: '', swapId: '' };
  }

  private async orgOfSwap(swapId: string): Promise<string | null> {
    if (this.swapOrg.has(swapId)) return this.swapOrg.get(swapId)!;
    const swap = await this.prisma.skiSwap.findUnique({ where: { id: swapId }, select: { orgId: true } });
    return remember(this.swapOrg, swapId, swap?.orgId ?? null);
  }

  private async orgExists(orgId: string): Promise<boolean> {
    if (this.orgIds.has(orgId)) return this.orgIds.get(orgId)!;
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    return remember(this.orgIds, orgId, !!org);
  }

  private async orgOfSlug(slug: string): Promise<string | null> {
    if (this.slugOrg.has(slug)) return this.slugOrg.get(slug)!;
    const org = await this.prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    return remember(this.slugOrg, slug, org?.id ?? null);
  }
}

function remember<V>(cache: Map<string, V>, key: string, value: V): V {
  // Cleared rather than evicted one at a time: this is a convenience, and a
  // full cache is somebody walking ids, who can pay for their own lookups.
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}
