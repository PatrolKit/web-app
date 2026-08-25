import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TimeClockFoldService } from './fold.service';
import { createId } from '@paralleldrive/cuid2';
import { parse as parseCsv } from 'csv-parse/sync';
import type { PatrollerResponse } from '../contracts/time-clock.contracts';

type PatrollerRow = {
  id: string;
  orgId: string;
  firstName: string;
  lastName: string;
  nspId: string;
  patrolLevel: string | null;
  active: boolean;
  deletedAt: Date | null;
  updatedAt: Date;
};

/**
 * Applied identically on the device before comparison (§5.7). Leading zeros are
 * significant — some divisions issue them — so only non-alphanumerics are stripped.
 */
export function normalizeNspId(raw: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function toTitleCase(s: string): string {
  return s.trim().replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

@Injectable()
export class PatrollerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foldService: TimeClockFoldService,
  ) {}

  /**
   * Tombstones are included unconditionally: a device that only ever sees live rows can
   * never learn that someone left the roster.
   */
  async list(orgId: string, updatedSince?: string): Promise<PatrollerResponse[]> {
    const patrollers = await this.prisma.patroller.findMany({
      where: {
        orgId,
        ...(updatedSince ? { updatedAt: { gt: new Date(updatedSince) } } : {}),
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    return patrollers.map(toResponse);
  }

  async create(
    orgId: string,
    data: {
      firstName: string;
      lastName: string;
      nspId: string;
      patrolLevel?: string | null;
      active: boolean;
    },
  ): Promise<PatrollerResponse> {
    const nspId = normalizeNspId(data.nspId);
    if (!nspId) throw new ConflictException('NSP ID cannot be empty');
    await this.assertNspAvailable(orgId, nspId);

    const patroller = await this.prisma.patroller.create({
      data: {
        id: createId(),
        orgId,
        firstName: toTitleCase(data.firstName),
        lastName: toTitleCase(data.lastName),
        nspId,
        patrolLevel: data.patrolLevel?.trim() || null,
        active: data.active,
      },
    });
    return toResponse(patroller);
  }

  async patch(
    orgId: string,
    patrollerId: string,
    data: {
      firstName?: string;
      lastName?: string;
      nspId?: string;
      patrolLevel?: string | null;
      active?: boolean;
    },
  ): Promise<PatrollerResponse & { closedShiftId: string | null }> {
    const existing = await this.prisma.patroller.findFirst({ where: { id: patrollerId, orgId } });
    if (!existing) throw new NotFoundException('Patroller not found');

    const nspId = data.nspId !== undefined ? normalizeNspId(data.nspId) : undefined;
    if (nspId && nspId !== existing.nspId) await this.assertNspAvailable(orgId, nspId);

    const patroller = await this.prisma.patroller.update({
      where: { id: patrollerId },
      data: {
        ...(data.firstName !== undefined ? { firstName: toTitleCase(data.firstName) } : {}),
        ...(data.lastName !== undefined ? { lastName: toTitleCase(data.lastName) } : {}),
        ...(nspId !== undefined ? { nspId } : {}),
        ...(data.patrolLevel !== undefined
          ? { patrolLevel: data.patrolLevel?.trim() || null }
          : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });

    // D14: no open shift outlives its patroller.
    const closedShiftId =
      data.active === false ? await this.closeOpenShift(orgId, patrollerId) : null;

    return { ...toResponse(patroller), closedShiftId };
  }

  /** Soft delete: the device needs the tombstone to drop the row from its roster. */
  async remove(orgId: string, patrollerId: string): Promise<{ closedShiftId: string | null }> {
    const existing = await this.prisma.patroller.findFirst({ where: { id: patrollerId, orgId } });
    if (!existing) throw new NotFoundException('Patroller not found');

    await this.prisma.patroller.update({
      where: { id: patrollerId },
      data: { active: false, deletedAt: new Date() },
    });
    return { closedShiftId: await this.closeOpenShift(orgId, patrollerId) };
  }

  /**
   * TC-S13 / D14. Writes an `admin` clock-out and recomputes, rather than editing the
   * shift directly — events stay the single source of truth, so the next recompute
   * agrees with this one.
   */
  private async closeOpenShift(orgId: string, patrollerId: string): Promise<string | null> {
    const open = await this.prisma.timeClockShift.findFirst({
      where: { orgId, patrollerId, status: 'open' },
    });
    if (!open) return null;

    const now = new Date();
    const occurredAt = now.getTime() > open.clockInAt.getTime() ? now : open.clockInAt;

    await this.prisma.$transaction(async (tx) => {
      await tx.timeClockEvent.create({
        data: {
          id: `admin-deactivate:${open.id}`,
          orgId,
          resortId: open.resortId,
          patrollerId,
          type: 'clock_out',
          source: 'admin',
          occurredAt,
          statusNote: 'Closed automatically when the patroller was removed from the roster',
        },
      });
      await this.foldService.recomputeForPatroller(orgId, patrollerId, tx);
    });

    return open.id;
  }

  private async assertNspAvailable(orgId: string, nspId: string): Promise<void> {
    const duplicate = await this.prisma.patroller.findFirst({ where: { orgId, nspId } });
    if (duplicate) {
      throw new ConflictException(
        `NSP ID ${nspId} already belongs to ${duplicate.firstName} ${duplicate.lastName}`,
      );
    }
  }

  // ─── CSV import (same two-step shape as the seller import) ─────────────────

  parseImportFile(buffer: Buffer): {
    headers: string[];
    mapping: Record<string, string | null>;
    rows: Record<string, string>[];
  } {
    const records = parseCsv(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];

    const headers = records.length ? Object.keys(records[0] ?? {}) : [];
    const find = (...candidates: string[]): string | null =>
      headers.find((h) => candidates.includes(h.toLowerCase().replace(/[^a-z]/g, ''))) ?? null;

    return {
      headers,
      mapping: {
        firstName: find('firstname', 'first', 'givenname'),
        lastName: find('lastname', 'last', 'surname', 'familyname'),
        nspId: find('nspid', 'nsp', 'id', 'memberid', 'nspnumber'),
        patrolLevel: find('patrollevel', 'level', 'certification', 'cert'),
      },
      rows: records,
    };
  }

  async importRows(
    orgId: string,
    rows: { firstName: string; lastName: string; nspId: string; patrolLevel?: string | null }[],
    strategy: 'preserve' | 'overwrite',
  ): Promise<{ created: number; updated: number; skipped: number; errors: string[] }> {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const [index, row] of rows.entries()) {
      const nspId = normalizeNspId(row.nspId ?? '');
      const firstName = toTitleCase(row.firstName ?? '');
      const lastName = toTitleCase(row.lastName ?? '');
      if (!nspId || !firstName || !lastName) {
        errors.push(`Row ${index + 1}: first name, last name, and NSP ID are all required`);
        skipped++;
        continue;
      }

      const existing = await this.prisma.patroller.findFirst({ where: { orgId, nspId } });
      if (existing) {
        if (strategy === 'preserve') {
          skipped++;
          continue;
        }
        await this.prisma.patroller.update({
          where: { id: existing.id },
          data: {
            firstName,
            lastName,
            patrolLevel: row.patrolLevel?.trim() || null,
            active: true,
            deletedAt: null,
          },
        });
        updated++;
        continue;
      }

      await this.prisma.patroller.create({
        data: {
          id: createId(),
          orgId,
          firstName,
          lastName,
          nspId,
          patrolLevel: row.patrolLevel?.trim() || null,
        },
      });
      created++;
    }

    return { created, updated, skipped, errors };
  }
}

function toResponse(p: PatrollerRow): PatrollerResponse {
  return {
    id: p.id,
    orgId: p.orgId,
    firstName: p.firstName,
    lastName: p.lastName,
    displayName: `${p.firstName} ${p.lastName}`.trim(),
    nspId: p.nspId,
    patrolLevel: p.patrolLevel,
    active: p.active,
    deletedAt: p.deletedAt ? p.deletedAt.toISOString() : null,
    updatedAt: p.updatedAt.toISOString(),
  };
}
