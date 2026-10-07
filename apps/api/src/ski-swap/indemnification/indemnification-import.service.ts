import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { displayName } from '../../common/util/person';
import {
  applyImport,
  parseEntriesCsv,
  planImport,
  type ExistingEntry,
  type ImportPlan,
  type TreeSnapshot,
} from './indemnification-import';
import { BINDING_MODEL_LABEL } from '../taxonomy/binding-tree';
import type {
  IndemnificationImportPlan,
  IndemnificationImportRecord,
  IndemnificationProgram,
  NssraDeclaration,
} from '../../contracts/indemnification.contracts';
import { SEASON_PATTERN } from '../../contracts/indemnification.contracts';

/**
 * The platform side of the registry (Plan 44 D8): the seasonal import, dry run
 * then commit, the programs and their notes, the import history, and which
 * patrols have declared NSSRA membership.
 */
@Injectable()
export class IndemnificationImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  /** The global binding makers and their models, as the planner reads them. */
  async snapshot(): Promise<TreeSnapshot> {
    const attr = await this.taxonomy.bindingManufacturerAttribute();
    if (!attr) {
      throw new BadRequestException('The shared list has no Bindings › Type › Skis › Manufacturer question to import under');
    }
    const makers = await this.prisma.taxonomyNode.findMany({
      where: { parentId: attr.id, kind: 'VALUE', orgId: null },
      select: { id: true, label: true },
      orderBy: { displayOrder: 'asc' },
    });
    const attrs = await this.prisma.taxonomyNode.findMany({
      where: { parentId: { in: makers.map((m) => m.id) }, kind: 'ATTRIBUTE', orgId: null },
      select: { id: true, parentId: true, label: true },
    });
    const modelAttrs = attrs.filter((a) => a.label.trim().toLowerCase() === BINDING_MODEL_LABEL.toLowerCase());
    const models = await this.prisma.taxonomyNode.findMany({
      where: { parentId: { in: modelAttrs.map((a) => a.id) }, kind: 'VALUE', orgId: null },
      select: { id: true, parentId: true, label: true },
    });
    return {
      manufacturerAttrId: attr.id,
      manufacturers: makers.map((m) => {
        const modelAttr = modelAttrs.find((a) => a.parentId === m.id) ?? null;
        return {
          id: m.id,
          label: m.label,
          modelAttrId: modelAttr?.id ?? null,
          models: modelAttr ? models.filter((v) => v.parentId === modelAttr.id).map((v) => ({ id: v.id, label: v.label })) : [],
        };
      }),
    };
  }

  private async plan(file: Buffer): Promise<{ plan: ImportPlan; tree: TreeSnapshot }> {
    const programs = await this.prisma.bindingIndemnificationProgram.findMany({ select: { key: true, latestSeason: true } });
    const { rows, errors } = parseEntriesCsv(file.toString('utf8'), new Set(programs.map((p) => p.key)));
    const tree = await this.snapshot();
    const existing = (await this.prisma.bindingIndemnification.findMany()) as ExistingEntry[];
    return { plan: planImport(rows, errors, tree, existing, programs), tree };
  }

  /** What the file would do. Nothing written (D8). */
  async dryRun(file: Buffer, season: string): Promise<IndemnificationImportPlan> {
    this.assertSeason(season);
    const { plan } = await this.plan(file);
    return this.describe(plan, season, null);
  }

  /** The file, written: one transaction, every org's tree version bumped, audited. */
  async commit(file: Buffer, season: string, actorId: string, fileName: string | null, ipAddress?: string): Promise<IndemnificationImportPlan> {
    this.assertSeason(season);
    const { plan, tree } = await this.plan(file);
    if (plan.errors.length) throw new BadRequestException({ message: 'The file has errors; nothing was imported', errors: plan.errors });
    if (plan.season && plan.season !== season) {
      throw new BadRequestException(`The file's newest season is ${plan.season}, not ${season}`);
    }
    const result = await this.prisma.$transaction(
      (tx) => applyImport(tx, plan, tree, { actorId, fileName }),
      { timeout: 180_000, maxWait: 15_000 },
    );
    // New global nodes are in every org's tree.
    await this.prisma.skiSwapSettings.updateMany({ data: { taxonomyVersion: { increment: 1 } } });
    await this.prisma.auditLog
      .create({
        data: {
          actorType: 'user',
          actorId,
          action: 'ski_swap.indemnification.imported',
          targetType: 'BindingIndemnificationImport',
          targetId: result.importId,
          ipAddress: ipAddress ?? null,
          metadata: {
            season,
            fileName,
            mintedManufacturers: result.mintedManufacturers,
            mintedModels: result.mintedModels,
            entriesWritten: result.entriesWritten,
          },
        },
      })
      .catch(() => {});
    return this.describe(plan, season, result.importId);
  }

  private assertSeason(season: string) {
    if (!SEASON_PATTERN.test(season)) throw new BadRequestException('season must be like 2025-26');
  }

  private async describe(plan: ImportPlan, season: string, importId: string | null): Promise<IndemnificationImportPlan> {
    const errors = [...plan.errors];
    if (plan.season && plan.season !== season) {
      errors.push({ line: 0, message: `The file's newest season is ${plan.season}, not ${season}` });
    }
    const programs = await this.prisma.bindingIndemnificationProgram.findMany({ select: { key: true, name: true } });
    const name = (key: string) => programs.find((p) => p.key === key)?.name ?? key;
    return {
      season: plan.season,
      rows: plan.rows,
      errors,
      mintManufacturers: plan.mintManufacturers.map((m) => m.label),
      mintModels: plan.mintModels.map((m) => ({ manufacturer: m.manufacturerLabel, model: m.label })),
      entries: {
        new: plan.entries.filter((e) => e.change === 'new').length,
        changed: plan.entries.filter((e) => e.change === 'changed').length,
        unchanged: plan.entries.filter((e) => e.change === 'unchanged').length,
      },
      lapsing: plan.lapsing.map((l) => ({
        program: { key: l.programKey, name: name(l.programKey) },
        fromSeason: l.fromSeason,
        toSeason: l.toSeason,
        models: l.models,
      })),
      programs: plan.programSeasons,
      committed: importId !== null,
      importId,
    };
  }

  // ─── Programs ──────────────────────────────────────────────────────────────

  async programs(): Promise<IndemnificationProgram[]> {
    const rows = await this.prisma.bindingIndemnificationProgram.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { entries: true } } },
    });
    const byIds = await this.names(rows.map((r) => r.updatedById));
    return rows.map((r) => ({
      key: r.key,
      name: r.name,
      notes: r.notes,
      latestSeason: r.latestSeason,
      entries: r._count.entries,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: r.updatedById ? byIds.get(r.updatedById) ?? null : null,
    }));
  }

  async patchProgram(key: string, data: { name?: string; notes?: string }, actorId: string): Promise<IndemnificationProgram> {
    const exists = await this.prisma.bindingIndemnificationProgram.findUnique({ where: { key } });
    if (!exists) throw new BadRequestException('No such program');
    await this.prisma.bindingIndemnificationProgram.update({
      where: { key },
      data: { ...(data.name !== undefined ? { name: data.name } : {}), ...(data.notes !== undefined ? { notes: data.notes } : {}), updatedById: actorId },
    });
    return (await this.programs()).find((p) => p.key === key)!;
  }

  async imports(): Promise<IndemnificationImportRecord[]> {
    const rows = await this.prisma.bindingIndemnificationImport.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    const byIds = await this.names(rows.map((r) => r.createdById));
    return rows.map((r) => ({
      id: r.id,
      season: r.season,
      fileName: r.fileName,
      counts: (r.counts ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdById ? byIds.get(r.createdById) ?? null : null,
    }));
  }

  /** Every org with the ski swap, and whether it has declared (D5). */
  async declarations(): Promise<NssraDeclaration[]> {
    const orgs = await this.prisma.organization.findMany({
      select: { id: true, name: true, skiSwapSettings: { select: { nssraMember: true, nssraMemberSetBy: true, nssraMemberSetAt: true } } },
      orderBy: { name: 'asc' },
    });
    const byIds = await this.names(orgs.map((o) => o.skiSwapSettings?.nssraMemberSetBy ?? null));
    return orgs.map((o) => ({
      orgId: o.id,
      orgName: o.name,
      nssraMember: o.skiSwapSettings?.nssraMember ?? false,
      setBy: o.skiSwapSettings?.nssraMemberSetBy ? byIds.get(o.skiSwapSettings.nssraMemberSetBy) ?? null : null,
      setAt: o.skiSwapSettings?.nssraMemberSetAt?.toISOString() ?? null,
    }));
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (wanted.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    });
    return new Map(users.map((u) => [u.id, displayName(u)]));
  }
}
