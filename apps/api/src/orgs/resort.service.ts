import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createId } from '@paralleldrive/cuid2';
import type {
  CreateResortRequest,
  PatchResortRequest,
  ResortResponse,
} from '../contracts/org.contracts';
import {
  DEFAULT_TIME_ZONE,
  isValidTimeZone,
  timeZoneForAddress,
} from '../common/util/us-time-zone';

type ResortRow = {
  id: string;
  orgId: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  timeZone: string;
  updatedAt: Date;
};

@Injectable()
export class ResortService {
  constructor(private readonly prisma: PrismaService) {}

  async list(orgId: string, updatedSince?: string): Promise<ResortResponse[]> {
    const resorts = await this.prisma.resort.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(updatedSince ? { updatedAt: { gt: new Date(updatedSince) } } : {}),
      },
      orderBy: { name: 'asc' },
    });
    return resorts.map(toResponse);
  }

  async create(orgId: string, data: CreateResortRequest): Promise<ResortResponse> {
    const name = data.name.trim();
    await this.assertNameFree(orgId, name);

    const address = normalizeAddress(data);
    const timeZone = this.resolveTimeZone(data.timeZone, address, DEFAULT_TIME_ZONE);

    const resort = await this.prisma.resort.create({
      data: { id: createId(), orgId, name, ...address, timeZone },
    });
    return toResponse(resort);
  }

  async patch(orgId: string, resortId: string, data: PatchResortRequest): Promise<ResortResponse> {
    const existing = await this.prisma.resort.findFirst({
      where: { id: resortId, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Resort not found');

    const name = data.name?.trim();
    if (name && name !== existing.name) await this.assertNameFree(orgId, name, resortId);

    // Only the address fields actually sent are touched. The time zone is
    // re-derived when the state or ZIP moves, so it can't drift out of sync —
    // but an edit that leaves the address alone preserves a manual override.
    const address = normalizeAddress(data, existing);
    const relocated = address.state !== existing.state || address.zip !== existing.zip;
    const timeZone =
      data.timeZone || relocated
        ? this.resolveTimeZone(data.timeZone, address, existing.timeZone)
        : existing.timeZone;

    const resort = await this.prisma.resort.update({
      where: { id: resortId },
      data: { ...(name ? { name } : {}), ...address, timeZone },
    });
    return toResponse(resort);
  }

  /**
   * Soft delete: shifts and events keep pointing at the row so history and the
   * hours report stay intact, but the resort drops out of every list.
   */
  async remove(orgId: string, resortId: string): Promise<void> {
    const existing = await this.prisma.resort.findFirst({
      where: { id: resortId, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Resort not found');

    await this.prisma.resort.update({
      where: { id: resortId },
      data: { deletedAt: new Date() },
    });
  }

  /** Names are unique among live resorts; a deleted one frees its name for reuse. */
  private async assertNameFree(orgId: string, name: string, exceptId?: string): Promise<void> {
    const duplicate = await this.prisma.resort.findFirst({
      where: { orgId, name, deletedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    });
    if (duplicate) throw new ConflictException(`A resort named "${name}" already exists`);
  }

  private resolveTimeZone(
    override: string | undefined,
    address: { state: string | null; zip: string | null },
    fallback: string,
  ): string {
    if (override) {
      if (!isValidTimeZone(override)) {
        throw new ConflictException(`"${override}" is not a valid IANA time zone`);
      }
      return override;
    }
    return timeZoneForAddress(address) ?? fallback;
  }
}

/** Trims, upper-cases the state, and keeps blanks as nulls rather than ''. */
function normalizeAddress(
  data: Partial<Pick<CreateResortRequest, 'street' | 'city' | 'state' | 'zip'>>,
  existing?: { street: string | null; city: string | null; state: string | null; zip: string | null },
): { street: string | null; city: string | null; state: string | null; zip: string | null } {
  const pick = (
    key: 'street' | 'city' | 'state' | 'zip',
    transform: (v: string) => string = (v) => v,
  ): string | null => {
    if (data[key] === undefined) return existing?.[key] ?? null;
    const value = (data[key] ?? '').trim();
    return value ? transform(value) : null;
  };

  return {
    street: pick('street'),
    city: pick('city'),
    state: pick('state', (v) => v.toUpperCase()),
    zip: pick('zip'),
  };
}

function toResponse(r: ResortRow): ResortResponse {
  return {
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    street: r.street,
    city: r.city,
    state: r.state,
    zip: r.zip,
    timeZone: r.timeZone,
    updatedAt: r.updatedAt.toISOString(),
  };
}
