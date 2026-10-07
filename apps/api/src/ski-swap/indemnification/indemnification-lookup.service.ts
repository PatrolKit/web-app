import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { BINDING_MODEL_LABEL } from '../taxonomy/binding-tree';
import { matchesQuery } from './indemnification-import';
import type {
  BindingLookup,
  BindingLookupDetail,
  BindingLookupEntry,
  IndemnificationLine,
  ManufacturersResponse,
} from '../../contracts/indemnification.contracts';

const SEARCH_CAP = 50;

type EntryRow = {
  nodeId: string;
  programKey: string;
  season: string;
  status: 'LISTED' | 'FINAL_SEASON';
  retail: boolean;
  rental: boolean;
  demo: boolean;
  currentLine: boolean | null;
  nonIso: boolean;
  source: 'NSSRA' | 'MANUFACTURER';
  sourceRef: string | null;
  note: string | null;
};

type Registry = {
  nssraMember: boolean;
  latestSeason: string | null;
  programs: Map<string, { key: string; name: string; notes: string; latestSeason: string | null }>;
  makers: { id: string; label: string }[];
  /** Model node → its maker. */
  makerOf: Map<string, { id: string; label: string }>;
  models: { id: string; label: string; makerId: string }[];
  /** Model node → the entries this patrol may see. */
  entries: Map<string, EntryRow[]>;
  /** Model node → entries hidden from this patrol (D5). */
  hidden: Map<string, number>;
};

/**
 * The patrol-facing side (Plan 44 D4, D5, D10): the answer for a model,
 * computed when asked against its program's latest season, with NSSRA-sourced
 * entries dropped for a patrol that hasn't declared membership.
 *
 * Reads the whole registry per request. It is a few thousand rows at most,
 * and a glance at check-in isn't worth a cache that can be stale.
 */
@Injectable()
export class IndemnificationLookupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  private async load(orgId: string): Promise<Registry> {
    const [settings, programRows, attr] = await Promise.all([
      this.prisma.skiSwapSettings.findUnique({ where: { orgId }, select: { nssraMember: true } }),
      this.prisma.bindingIndemnificationProgram.findMany(),
      this.taxonomy.bindingManufacturerAttribute(),
    ]);
    const nssraMember = settings?.nssraMember ?? false;
    const programs = new Map(programRows.map((p) => [p.key, p]));
    const seasons = programRows.map((p) => p.latestSeason).filter((s): s is string => !!s).sort();
    const latestSeason = seasons.length ? seasons[seasons.length - 1] : null;
    const empty: Registry = { nssraMember, latestSeason, programs, makers: [], makerOf: new Map(), models: [], entries: new Map(), hidden: new Map() };
    if (!attr) return empty;

    const visible = { OR: [{ orgId: null }, { orgId }], status: 'APPROVED' as const, retiredAt: null };
    const makers = await this.prisma.taxonomyNode.findMany({
      where: { parentId: attr.id, kind: 'VALUE', ...visible },
      select: { id: true, label: true },
      orderBy: [{ displayOrder: 'asc' }, { label: 'asc' }],
    });
    const modelAttrs = await this.prisma.taxonomyNode.findMany({
      where: { parentId: { in: makers.map((m) => m.id) }, kind: 'ATTRIBUTE', ...visible },
      select: { id: true, parentId: true, label: true },
    });
    const modelAttrIds = modelAttrs
      .filter((a) => a.label.trim().toLowerCase() === BINDING_MODEL_LABEL.toLowerCase())
      .map((a) => a.id);
    const modelRows = await this.prisma.taxonomyNode.findMany({
      where: { parentId: { in: modelAttrIds }, kind: 'VALUE', ...visible },
      select: { id: true, label: true, parentId: true },
      orderBy: [{ displayOrder: 'asc' }, { label: 'asc' }],
    });
    const makerByAttr = new Map(modelAttrs.map((a) => [a.id, makers.find((m) => m.id === a.parentId)!]));
    const models = modelRows.map((v) => ({ id: v.id, label: v.label, makerId: makerByAttr.get(v.parentId!)!.id }));
    const makerOf = new Map(modelRows.map((v) => [v.id, makerByAttr.get(v.parentId!)!]));

    const entryRows = (await this.prisma.bindingIndemnification.findMany({
      where: { nodeId: { in: models.map((m) => m.id) } },
      orderBy: { season: 'desc' },
    })) as EntryRow[];
    const entries = new Map<string, EntryRow[]>();
    const hidden = new Map<string, number>();
    for (const e of entryRows) {
      if (e.source === 'NSSRA' && !nssraMember) {
        hidden.set(e.nodeId, (hidden.get(e.nodeId) ?? 0) + 1);
        continue;
      }
      const list = entries.get(e.nodeId);
      if (list) list.push(e);
      else entries.set(e.nodeId, [e]);
    }
    return { nssraMember, latestSeason, programs, makers, makerOf, models, entries, hidden };
  }

  private lines(e: EntryRow): IndemnificationLine[] {
    return [e.retail ? 'retail' : null, e.rental ? 'rental' : null, e.demo ? 'demo' : null].filter((l): l is IndemnificationLine => !!l);
  }

  /** D4, for one model. */
  private answer(reg: Registry, model: { id: string; label: string; makerId: string }): BindingLookup {
    const maker = reg.makerOf.get(model.id)!;
    const base = {
      nodeId: model.id,
      manufacturerId: maker.id,
      manufacturer: maker.label,
      model: model.label,
      lines: [] as IndemnificationLine[],
      currentLine: null as boolean | null,
      nonIso: false,
      program: null as { key: string; name: string } | null,
      note: null as string | null,
    };
    const held = reg.entries.get(model.id) ?? [];
    if (held.length === 0) {
      const hidden = reg.hidden.get(model.id) ?? 0;
      return { ...base, answer: hidden > 0 ? 'unavailable' : 'not_listed', season: null, lastListedSeason: null };
    }
    const latest = held[0]; // newest season first
    const program = reg.programs.get(latest.programKey);
    const programRef = program ? { key: program.key, name: program.name } : { key: latest.programKey, name: latest.programKey };
    const season = program?.latestSeason ?? latest.season;
    const current = held.find((e) => e.season === season);
    if (!current) {
      return {
        ...base,
        answer: 'lapsed',
        season,
        lastListedSeason: latest.season,
        lines: this.lines(latest),
        currentLine: latest.currentLine,
        nonIso: latest.nonIso,
        program: programRef,
        note: latest.note,
      };
    }
    return {
      ...base,
      answer: current.status === 'FINAL_SEASON' ? 'final_season' : 'indemnified',
      season,
      lastListedSeason: current.season,
      lines: this.lines(current),
      currentLine: current.currentLine,
      nonIso: current.nonIso,
      program: programRef,
      note: current.note,
    };
  }

  async manufacturers(orgId: string): Promise<ManufacturersResponse> {
    const reg = await this.load(orgId);
    const answers = reg.models.map((m) => this.answer(reg, m));
    return {
      nssraMember: reg.nssraMember,
      latestSeason: reg.latestSeason,
      manufacturers: reg.makers.map((maker) => {
        const mine = answers.filter((a) => a.manufacturerId === maker.id);
        const programs = new Map<string, { key: string; name: string }>();
        for (const a of mine) if (a.program) programs.set(a.program.key, a.program);
        return {
          nodeId: maker.id,
          label: maker.label,
          models: mine.length,
          listed: mine.filter((a) => a.answer === 'indemnified' || a.answer === 'final_season').length,
          programs: [...programs.values()],
        };
      }),
    };
  }

  async models(orgId: string, manufacturerId: string): Promise<BindingLookup[]> {
    const reg = await this.load(orgId);
    if (!reg.makers.some((m) => m.id === manufacturerId)) throw new NotFoundException('No such binding manufacturer');
    return reg.models.filter((m) => m.makerId === manufacturerId).map((m) => this.answer(reg, m));
  }

  /** Every token of the query starts a token of "maker model"; brand order, then model. */
  async search(orgId: string, q: string): Promise<BindingLookup[]> {
    const reg = await this.load(orgId);
    if (!q.trim()) return [];
    const hits: BindingLookup[] = [];
    for (const m of reg.models) {
      const maker = reg.makerOf.get(m.id)!;
      if (!matchesQuery(`${maker.label} ${m.label}`, q)) continue;
      hits.push(this.answer(reg, m));
    }
    hits.sort((a, b) => a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model));
    return hits.slice(0, SEARCH_CAP);
  }

  async model(orgId: string, nodeId: string): Promise<BindingLookupDetail> {
    const reg = await this.load(orgId);
    const model = reg.models.find((m) => m.id === nodeId);
    if (!model) throw new NotFoundException('Not a binding model this patrol can see');
    const answer = this.answer(reg, model);
    const held = reg.entries.get(nodeId) ?? [];
    const entries: BindingLookupEntry[] = held.map((e) => {
      const p = reg.programs.get(e.programKey);
      return {
        season: e.season,
        status: e.status === 'FINAL_SEASON' ? 'final_season' : 'listed',
        lines: this.lines(e),
        currentLine: e.currentLine,
        nonIso: e.nonIso,
        source: e.source === 'NSSRA' ? 'nssra' : 'manufacturer',
        sourceRef: e.sourceRef,
        note: e.note,
        program: p ? { key: p.key, name: p.name } : { key: e.programKey, name: e.programKey },
      };
    });
    const program = answer.program ? reg.programs.get(answer.program.key) : null;
    return { ...answer, entries, programNotes: program?.notes || null, hiddenEntries: reg.hidden.get(nodeId) ?? 0 };
  }
}
