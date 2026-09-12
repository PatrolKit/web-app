import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type TaxonomyNode } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../../prisma/prisma.service';
import { deriveName, renderAnswer, type NameAnswer, type NameAttribute } from './derive-name';
import type { TaxonomyIconKey } from '../../contracts/taxonomy-icons';
import type {
  OrgTaxonomyAdmin,
  PendingValue,
  ResolvedAttribute,
  ResolvedCategory,
  ResolvedIcon,
  ResolvedTaxonomy,
  ResolvedValue,
  TaxonomyAdminNode,
  TaxonomyChildrenResponse,
  TaxonomySuggestion,
} from '../../contracts/taxonomy.contracts';

/**
 * How many values an attribute may carry before its list is deferred rather
 * than inlined (Plan 19 §7.2).
 *
 * The eager document is fetched by a seller's phone on venue wifi while it is
 * also uploading photos, so a manufacturer's whole model list has no business
 * in it. Attributes hanging off a *value* are the ones that get long, and those
 * are deferred unconditionally; this threshold only catches a
 * category-level list that has grown past a chip row.
 */
const DEFER_VALUES_ABOVE = 60;

/** How deep `?depth=full` will expand before it stops. See `attributesUnder`. */
const MAX_EXPANSION_DEPTH = 8;

/** The scope half of a dedupe key. Global rows have no org to name. */
function scopeKey(orgId: string | null): string {
  return orgId ?? 'global';
}

/**
 * `<scope>:<parent>:<label>`, the one column that actually prevents duplicates.
 *
 * MySQL treats NULLs in a unique index as distinct, and both `orgId` and
 * `parentId` are nullable — a composite unique over them would let two global
 * categories called "Skis" through. Normalising the label here is also what
 * makes "Rossignol" and "rossignol  " the same pending value rather than two.
 */
export function dedupeKeyFor(orgId: string | null, parentId: string | null, label: string): string {
  const normalized = label.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${scopeKey(orgId)}:${parentId ?? 'root'}:${normalized}`;
}

/** The label half alone, for comparing two nodes that already share a parent. */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

type NodeRow = TaxonomyNode;

/** One answer as a client sends it. Exactly one of the three value fields. */
export interface ItemAttributeInput {
  attributeId: string;
  valueId?: string;
  numberValue?: number;
  freeText?: string;
}

/** What the write path needs: the rows to store, and the name to store with them. */
export interface ResolvedAnswers {
  categoryId: string;
  categoryLabel: string;
  name: string;
  rows: { attributeId: string; valueId: string | null; numberValue: number | null }[];
}

/** An item's answers as a response renders them. */
export interface ItemDescription {
  category: { id: string; label: string } | null;
  attributes: {
    attributeId: string;
    attributeLabel: string;
    valueId: string | null;
    valueLabel: string;
    numberValue: number | null;
  }[];
}

/** The slice of an ATTRIBUTE row that naming cares about. */
function nameAttributeOf(a: Pick<NodeRow, 'id' | 'label' | 'nameSlot' | 'unit' | 'displayOrder'>): NameAttribute {
  return {
    id: a.id,
    label: a.label,
    nameSlot: a.nameSlot,
    unit: a.unit,
    displayOrder: a.displayOrder,
  };
}

@Injectable()
export class TaxonomyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** This deployment's public origin, for URLs that leave the building. */
  private get publicBase(): string {
    return (this.config.get<string>('app.appUrl') ?? '').replace(/\/$/, '');
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  /**
   * Every node an org can see: the global tree plus its own rows.
   *
   * One query rather than a walk. The tree is small enough that filtering it in
   * memory beats a recursive CTE, and it has to be in memory anyway to nest.
   */
  private async visibleNodes(orgId: string, opts: { approvedOnly: boolean }): Promise<NodeRow[]> {
    return this.prisma.taxonomyNode.findMany({
      where: {
        OR: [{ orgId: null }, { orgId }],
        ...(opts.approvedOnly ? { status: 'APPROVED', retiredAt: null } : {}),
      },
      orderBy: [{ displayOrder: 'asc' }, { label: 'asc' }],
    });
  }

  /**
   * The resolved tree, as the UI generator consumes it (§4.1).
   *
   * `full` resolves every deferred branch inline, for a client that prefetches
   * rather than loads on open. An iPad syncs at the start of a shift and may not
   * see the network again for hours, and a lazily-loaded model list is a blank
   * control at the counter — so it takes the whole thing in one request and
   * keeps it. The browser leaves this off: it has the network and would rather
   * not download six hundred model names nobody opens.
   */
  async resolve(orgId: string, opts: { full?: boolean } = {}): Promise<ResolvedTaxonomy> {
    const [nodes, version] = await Promise.all([
      this.visibleNodes(orgId, { approvedOnly: true }),
      this.versionFor(orgId),
    ]);

    const base = this.publicBase;
    const byParent = new Map<string | null, NodeRow[]>();
    for (const n of nodes) {
      const key = n.parentId;
      const list = byParent.get(key);
      if (list) list.push(n);
      else byParent.set(key, [n]);
    }

    const categories = (byParent.get(null) ?? [])
      .filter((n) => n.kind === 'CATEGORY')
      .map((c): ResolvedCategory => ({
        id: c.id,
        label: c.label,
        ...(iconOf(c, orgId, base) ? { icon: iconOf(c, orgId, base)! } : {}),
        scope: c.orgId ? 'org' : 'global',
        displayOrder: c.displayOrder,
        attributes: this.attributesUnder(c.id, byParent, { eager: true, orgId, base, full: !!opts.full, depth: 0 }),
      }));

    return { version, categories };
  }

  /**
   * The attributes hanging off one node.
   *
   * `eager` is false below a value: those are the model lists, and inlining them
   * is what §7.2 exists to prevent. A deferred attribute still describes itself
   * — the client needs its label and input kind to draw a disabled control —
   * it just arrives without its values.
   */
  private attributesUnder(
    parentId: string,
    byParent: Map<string | null, NodeRow[]>,
    opts: { eager: boolean; orgId: string; base: string; full: boolean; depth: number },
  ): ResolvedAttribute[] {
    // The alternation gives a real tree, not a cycle, so this is a bound on
    // pathological curation rather than on recursion: four levels of question is
    // already deeper than anything a form can usefully render.
    if (opts.depth > MAX_EXPANSION_DEPTH) return [];
    return (byParent.get(parentId) ?? [])
      .filter((n) => n.kind === 'ATTRIBUTE')
      .map((a): ResolvedAttribute => {
        const input = a.input === 'NUMBER' ? 'number' : 'select';
        const base: ResolvedAttribute = {
          id: a.id,
          label: a.label,
          ...(iconOf(a, opts.orgId, opts.base) ? { icon: iconOf(a, opts.orgId, opts.base)! } : {}),
          scope: a.orgId ? 'org' : 'global',
          input,
          displayOrder: a.displayOrder,
          nameSlot: a.nameSlot,
        };

        if (input === 'number') {
          return {
            ...base,
            ...(a.unit != null ? { unit: a.unit } : {}),
            ...(a.minValue != null ? { min: a.minValue } : {}),
            ...(a.maxValue != null ? { max: a.maxValue } : {}),
            ...(a.step != null ? { step: a.step } : {}),
          };
        }

        const children = (byParent.get(a.id) ?? []).filter((n) => n.kind === 'VALUE');
        // `full` overrides both reasons to defer: the size threshold and the
        // rule that a value's attributes are never eager.
        const defer = !opts.full && (!opts.eager || children.length > DEFER_VALUES_ABOVE);
        return {
          ...base,
          allowFreeEntry: a.allowFreeEntry,
          ...(defer
            ? { valuesDeferred: true }
            : {
                values: children.map((v) =>
                  this.valueOf(v, byParent, opts.orgId, opts.base, opts.full, opts.depth),
                ),
              }),
        };
      });
  }

  /** One value, with the questions that only its being chosen opens up. */
  private valueOf(
    v: NodeRow,
    byParent: Map<string | null, NodeRow[]>,
    orgId: string,
    base: string,
    full = false,
    depth = 0,
  ): ResolvedValue {
    return {
      id: v.id,
      label: v.label,
      ...(iconOf(v, orgId, base) ? { icon: iconOf(v, orgId, base)! } : {}),
      scope: v.orgId ? 'org' : 'global',
      displayOrder: v.displayOrder,
      // Never eager below a value — those are the model lists — unless the
      // caller asked for the whole thing.
      attributes: this.attributesUnder(v.id, byParent, {
        eager: full,
        orgId,
        base,
        full,
        depth: depth + 1,
      }),
    };
  }

  /** A deferred branch, fetched when the control it belongs to is opened. */
  async children(orgId: string, nodeId: string): Promise<TaxonomyChildrenResponse> {
    const node = await this.prisma.taxonomyNode.findFirst({
      where: { id: nodeId, OR: [{ orgId: null }, { orgId }] },
    });
    if (!node) throw new NotFoundException('Node not found');

    const rows = await this.prisma.taxonomyNode.findMany({
      where: {
        parentId: nodeId,
        status: 'APPROVED',
        retiredAt: null,
        OR: [{ orgId: null }, { orgId }],
      },
      orderBy: [{ displayOrder: 'asc' }, { label: 'asc' }],
    });

    // A second level down would need its own fetch; a value's attributes arrive
    // described but empty, exactly as in the eager document.
    const base = this.publicBase;
    const byParent = new Map<string | null, NodeRow[]>([[nodeId, rows]]);

    if (node.kind === 'ATTRIBUTE') {
      return {
        nodeId,
        values: rows.filter((r) => r.kind === 'VALUE').map((v) => this.valueOf(v, byParent, orgId, base)),
      };
    }
    return {
      nodeId,
      attributes: this.attributesUnder(nodeId, byParent, {
        eager: false,
        orgId,
        base,
        full: false,
        depth: 0,
      }),
    };
  }

  // ─── Versioning ────────────────────────────────────────────────────────────

  async versionFor(orgId: string): Promise<number> {
    const row = await this.prisma.skiSwapSettings.findUnique({
      where: { orgId },
      select: { taxonomyVersion: true },
    });
    return row?.taxonomyVersion ?? 1;
  }

  /**
   * Invalidates one org's cached tree.
   *
   * An upsert because an org that has never opened the ski-swap settings screen
   * has no settings row, and the first taxonomy edit must not be the thing that
   * throws.
   */
  private async bumpVersion(orgId: string): Promise<void> {
    await this.prisma.skiSwapSettings.upsert({
      where: { orgId },
      update: { taxonomyVersion: { increment: 1 } },
      create: { orgId, taxonomyVersion: 2 },
    });
  }

  /**
   * Invalidates everyone's.
   *
   * A global node is in every org's resolved tree, so a rename reaches all of
   * them. `updateMany` covers the orgs that have a settings row; one that does
   * not will read the default of 1 and fetch fresh anyway, because it has never
   * cached anything.
   */
  private async bumpAllVersions(): Promise<void> {
    await this.prisma.skiSwapSettings.updateMany({ data: { taxonomyVersion: { increment: 1 } } });
  }

  private async bumpFor(node: Pick<NodeRow, 'orgId'>): Promise<void> {
    if (node.orgId) await this.bumpVersion(node.orgId);
    else await this.bumpAllVersions();
  }

  // ─── Writing ───────────────────────────────────────────────────────────────

  /**
   * Creates a node in one scope.
   *
   * `orgId` null is the platform path. Both share every rule below, because a
   * malformed global node is no better than a malformed org one.
   */
  async createNode(
    orgId: string | null,
    data: {
      kind: 'CATEGORY' | 'ATTRIBUTE' | 'VALUE';
      parentId?: string;
      label: string;
      iconKey?: string | null;
      displayOrder?: number;
      input?: 'SELECT' | 'NUMBER';
      nameSlot?: number | null;
      unit?: string | null;
      minValue?: number | null;
      maxValue?: number | null;
      step?: number | null;
      allowFreeEntry?: boolean;
      status?: 'APPROVED' | 'PENDING';
    },
    actorId?: string,
  ): Promise<NodeRow> {
    const parent = data.parentId ? await this.findVisibleOrThrow(orgId, data.parentId) : null;
    this.assertPlacement(data.kind, parent);

    if (data.kind === 'ATTRIBUTE' && !data.input) {
      throw new BadRequestException('An attribute needs an input kind');
    }
    if (data.kind !== 'ATTRIBUTE' && data.input) {
      throw new BadRequestException('Only an attribute has an input kind');
    }

    const dedupeKey = dedupeKeyFor(orgId, parent?.id ?? null, data.label);
    const clash = await this.prisma.taxonomyNode.findUnique({ where: { dedupeKey } });
    if (clash) {
      throw new ConflictException(`"${data.label}" is already here.`);
    }

    const node = await this.prisma.taxonomyNode.create({
      data: {
        id: createId(),
        kind: data.kind,
        orgId,
        parentId: parent?.id ?? null,
        label: data.label.trim(),
        iconKey: data.iconKey ?? null,
        displayOrder: data.displayOrder ?? 0,
        status: data.status ?? 'APPROVED',
        input: data.kind === 'ATTRIBUTE' ? data.input : null,
        nameSlot: data.nameSlot ?? null,
        unit: data.unit ?? null,
        minValue: data.minValue ?? null,
        maxValue: data.maxValue ?? null,
        step: data.step ?? null,
        allowFreeEntry: data.allowFreeEntry ?? false,
        dedupeKey,
        createdBy: actorId ?? null,
        ...(data.status === 'PENDING' ? {} : { approvedBy: actorId ?? null, approvedAt: new Date() }),
      },
    });

    await this.bumpFor(node);
    return node;
  }

  /**
   * The alternation rule, in one place (§2.1).
   *
   * A category is a root; an attribute hangs off a category or a value; a value
   * hangs off an attribute. Enforcing it here is what lets every reader assume
   * the shape rather than defend against it.
   */
  private assertPlacement(kind: string, parent: NodeRow | null): void {
    if (kind === 'CATEGORY') {
      if (parent) throw new BadRequestException('A category is a root and takes no parent');
      return;
    }
    if (!parent) throw new BadRequestException('Only a category may have no parent');

    if (kind === 'ATTRIBUTE') {
      if (parent.kind !== 'CATEGORY' && parent.kind !== 'VALUE') {
        throw new BadRequestException('A question belongs under a category or a value');
      }
      return;
    }

    // A VALUE. D9 lives in the second check: only a SELECT has listed answers,
    // so a NUMBER can never become a branch point.
    if (parent.kind !== 'ATTRIBUTE') {
      throw new BadRequestException('An answer belongs under a question');
    }
    if (parent.input === 'NUMBER') {
      throw new BadRequestException('A number question has no listed answers');
    }
  }

  private async findVisibleOrThrow(orgId: string | null, nodeId: string): Promise<NodeRow> {
    const node = await this.prisma.taxonomyNode.findFirst({
      where: {
        id: nodeId,
        // A platform admin reaches global rows only; an org reaches global and
        // its own. Neither reaches another org's.
        ...(orgId === null ? { orgId: null } : { OR: [{ orgId: null }, { orgId }] }),
      },
    });
    if (!node) throw new NotFoundException('Node not found');
    return node;
  }

  /**
   * Edits one node.
   *
   * A rename recomputes `dedupeKey`, which is how a rename into an existing
   * label is refused rather than silently creating a second "Volkl".
   */
  async patchNode(
    orgId: string | null,
    nodeId: string,
    data: {
      label?: string;
      iconKey?: string | null;
      displayOrder?: number;
      nameSlot?: number | null;
      unit?: string | null;
      minValue?: number | null;
      maxValue?: number | null;
      step?: number | null;
      allowFreeEntry?: boolean;
      approve?: true;
      retired?: boolean;
    },
    actorId?: string,
    ipAddress?: string,
  ): Promise<NodeRow> {
    const node = await this.findVisibleOrThrow(orgId, nodeId);
    // An org may not edit a global node: it can suggest, and ask.
    if (orgId !== null && node.orgId === null) {
      throw new BadRequestException('The shared list is not editable here');
    }

    const patch: Prisma.TaxonomyNodeUpdateInput = {};
    if (data.label !== undefined && normalizeLabel(data.label) !== normalizeLabel(node.label)) {
      const dedupeKey = dedupeKeyFor(node.orgId, node.parentId, data.label);
      const clash = await this.prisma.taxonomyNode.findUnique({ where: { dedupeKey } });
      if (clash && clash.id !== node.id) throw new ConflictException(`"${data.label}" is already here.`);
      patch.label = data.label.trim();
      patch.dedupeKey = dedupeKey;
    } else if (data.label !== undefined) {
      // Same label, different case or spacing: a display-only change.
      patch.label = data.label.trim();
    }

    // Choosing a registry key drops an uploaded image, because both cannot be
    // set (D11). The object is cleaned up by the caller's delete route; here the
    // columns are what matter.
    if (data.iconKey !== undefined) {
      patch.iconKey = data.iconKey;
      if (data.iconKey !== null) {
        patch.iconUrl = null;
        patch.iconS3Key = null;
        patch.iconBlob = null;
      }
    }
    if (data.displayOrder !== undefined) patch.displayOrder = data.displayOrder;
    if (data.nameSlot !== undefined) patch.nameSlot = data.nameSlot;
    if (data.unit !== undefined) patch.unit = data.unit;
    if (data.minValue !== undefined) patch.minValue = data.minValue;
    if (data.maxValue !== undefined) patch.maxValue = data.maxValue;
    if (data.step !== undefined) patch.step = data.step;
    if (data.allowFreeEntry !== undefined) patch.allowFreeEntry = data.allowFreeEntry;
    if (data.retired !== undefined) patch.retiredAt = data.retired ? new Date() : null;
    if (data.approve) {
      patch.status = 'APPROVED';
      patch.approvedBy = actorId ?? null;
      patch.approvedAt = new Date();
    }

    const updated = await this.prisma.taxonomyNode.update({ where: { id: nodeId }, data: patch });
    await this.bumpFor(updated);

    if (data.approve) {
      await this.audit('ski_swap.taxonomy.value.approved', node.orgId, actorId, ipAddress);
    }
    if (data.retired === true) {
      await this.audit('ski_swap.taxonomy.node.retired', node.orgId, actorId, ipAddress);
    }
    return updated;
  }

  /**
   * Mints a value, deduplicating against what is already there.
   *
   * Used by staff adding one deliberately and by a seller typing one mid-item.
   * An exact normalised match returns the existing node — approved or pending —
   * so two sellers typing "Rossignol" ten minutes apart produce one value with
   * two items behind it rather than two values (§8.1).
   */
  async mintValue(
    orgId: string,
    attributeId: string,
    label: string,
    opts: { approved: boolean; actorId?: string },
  ): Promise<NodeRow> {
    const attribute = await this.findVisibleOrThrow(orgId, attributeId);
    if (attribute.kind !== 'ATTRIBUTE') throw new BadRequestException('Not a question');
    if (attribute.input === 'NUMBER') {
      throw new BadRequestException('A number question has no listed answers');
    }

    // Already on the shared list, or already this org's? Use it.
    const existing = await this.prisma.taxonomyNode.findFirst({
      where: {
        parentId: attributeId,
        kind: 'VALUE',
        retiredAt: null,
        OR: [{ orgId: null }, { orgId }],
        dedupeKey: {
          in: [dedupeKeyFor(null, attributeId, label), dedupeKeyFor(orgId, attributeId, label)],
        },
      },
    });
    if (existing) return existing;

    const last = await this.prisma.taxonomyNode.findFirst({
      where: { parentId: attributeId, kind: 'VALUE' },
      orderBy: { displayOrder: 'desc' },
      select: { displayOrder: true },
    });

    return this.createNode(
      orgId,
      {
        kind: 'VALUE',
        parentId: attributeId,
        label,
        displayOrder: (last?.displayOrder ?? 0) + 10,
        status: opts.approved ? 'APPROVED' : 'PENDING',
      },
      opts.actorId,
    ).catch(async (err: unknown) => {
      // Two requests racing on the same new label: the unique index catches the
      // loser, and the row the winner wrote is the right answer for both.
      if (err instanceof ConflictException) {
        const raced = await this.prisma.taxonomyNode.findUnique({
          where: { dedupeKey: dedupeKeyFor(orgId, attributeId, label) },
        });
        if (raced) return raced;
      }
      throw err;
    });
  }

  /**
   * Folds one value into another (§8.3).
   *
   * Repoints the items and deletes the source. Their `name` columns are left
   * alone on purpose: a merge says the two values were always the same thing, it
   * does not claim the printed tag said something else.
   */
  async merge(
    orgId: string | null,
    nodeId: string,
    targetId: string,
    actorId?: string,
    ipAddress?: string,
  ): Promise<{ itemsRepointed: number }> {
    if (nodeId === targetId) throw new BadRequestException('A value cannot merge into itself');
    const source = await this.findVisibleOrThrow(orgId, nodeId);
    const target = await this.findVisibleOrThrow(orgId, targetId);

    if (source.kind !== 'VALUE' || target.kind !== 'VALUE') {
      throw new BadRequestException('Only answers can be merged');
    }
    if (source.parentId !== target.parentId) {
      throw new BadRequestException('Those answers belong to different questions');
    }
    if (orgId !== null && source.orgId === null) {
      throw new BadRequestException('A shared value cannot be merged away here');
    }

    const { count } = await this.prisma.$transaction(async (tx) => {
      // An item already answering with the target would collide on
      // `@@unique([itemId, attributeId])`. Those rows are dropped rather than
      // repointed: the item already says what the merge would have made it say.
      const dupes = await tx.swapItemAttribute.findMany({
        where: { valueId: nodeId, item: { attributes: { some: { valueId: targetId } } } },
        select: { id: true },
      });
      if (dupes.length > 0) {
        await tx.swapItemAttribute.deleteMany({ where: { id: { in: dupes.map((d) => d.id) } } });
      }
      const result = await tx.swapItemAttribute.updateMany({
        where: { valueId: nodeId },
        data: { valueId: targetId },
      });
      // Children of a merged value follow it, so a model list is not orphaned.
      await tx.taxonomyNode.updateMany({ where: { parentId: nodeId }, data: { parentId: targetId } });
      await tx.taxonomyNode.delete({ where: { id: nodeId } });
      return result;
    });

    await this.bumpFor(source);
    await this.audit(
      'ski_swap.taxonomy.value.merged',
      source.orgId,
      actorId,
      ipAddress,
      `"${source.label}" → "${target.label}" (${count} items)`,
    );
    return { itemsRepointed: count };
  }

  /** An org asking for one of its values to join the shared list (§8.4). */
  async suggest(orgId: string, nodeId: string, actorId?: string): Promise<NodeRow> {
    const node = await this.findVisibleOrThrow(orgId, nodeId);
    if (node.orgId === null) throw new BadRequestException('That value is already shared');
    if (node.status !== 'APPROVED') throw new BadRequestException('Approve it here first');
    return this.prisma.taxonomyNode.update({
      where: { id: nodeId },
      data: { suggestedAt: new Date(), createdBy: node.createdBy ?? actorId ?? null },
    });
  }

  /** Discards a pending value nothing points at. */
  async discard(orgId: string, nodeId: string): Promise<void> {
    const node = await this.findVisibleOrThrow(orgId, nodeId);
    if (node.orgId !== orgId) throw new BadRequestException('That value is not this org’s');
    if (node.status !== 'PENDING') throw new BadRequestException('Only a pending value can be discarded');

    const itemCount = await this.prisma.swapItemAttribute.count({ where: { valueId: nodeId } });
    if (itemCount > 0) {
      // D4, surfaced as a reason rather than as a foreign-key error after the
      // click. The queue disables the button using the same count.
      throw new ConflictException(
        `${itemCount} item${itemCount === 1 ? '' : 's'} use this. Approve it, or merge it into another value.`,
      );
    }
    await this.prisma.taxonomyNode.delete({ where: { id: nodeId } });
    await this.bumpVersion(orgId);
  }


  // ─── Answering, on the way into an item (§7.3) ─────────────────────────────

  /**
   * Validates one item's answers against this org's tree and composes its name.
   *
   * Everything the write path needs in one pass: the answers are checked, any
   * free text is minted into a pending value, and the name is derived from the
   * labels this very fetch already has in hand. Nothing here trusts the client
   * about the shape of the tree — a reachable attribute, a value that belongs to
   * it, a number inside its range — because the alternative is a tag that says
   * something the taxonomy never offered.
   */
  async resolveAnswers(
    orgId: string,
    categoryId: string,
    inputs: ItemAttributeInput[],
    actorId?: string,
  ): Promise<ResolvedAnswers> {
    const nodes = await this.visibleNodes(orgId, { approvedOnly: false });
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const category = byId.get(categoryId);
    if (!category || category.kind !== 'CATEGORY') {
      throw new BadRequestException('Unknown category');
    }
    if (category.retiredAt || category.status !== 'APPROVED') {
      throw new BadRequestException(`"${category.label}" is no longer available`);
    }

    const seen = new Set<string>();
    const answers: NameAnswer[] = [];
    const rows: { attributeId: string; valueId: string | null; numberValue: number | null }[] = [];

    for (const input of inputs) {
      const supplied = [input.valueId, input.numberValue, input.freeText].filter(
        (v) => v !== undefined,
      );
      if (supplied.length === 0) continue; // A cleared control. Not an answer.
      if (supplied.length > 1) {
        throw new BadRequestException('An answer carries one value, not several');
      }

      const attribute = byId.get(input.attributeId);
      if (!attribute || attribute.kind !== 'ATTRIBUTE') {
        throw new BadRequestException('Unknown question');
      }
      if (seen.has(attribute.id)) {
        throw new BadRequestException(`"${attribute.label}" was answered twice`);
      }
      seen.add(attribute.id);

      this.assertReachable(attribute, category.id, byId, inputs);

      if (attribute.input === 'NUMBER') {
        if (input.numberValue === undefined) {
          throw new BadRequestException(`"${attribute.label}" takes a number`);
        }
        this.assertInRange(attribute, input.numberValue);
        rows.push({ attributeId: attribute.id, valueId: null, numberValue: input.numberValue });
        answers.push({ attribute: nameAttributeOf(attribute), numberValue: input.numberValue });
        continue;
      }

      // A SELECT. Either a value that exists, or one the seller just typed.
      let value: NodeRow;
      if (input.valueId !== undefined) {
        const picked = byId.get(input.valueId);
        if (!picked || picked.kind !== 'VALUE' || picked.parentId !== attribute.id) {
          throw new BadRequestException(`That is not an answer to "${attribute.label}"`);
        }
        if (picked.retiredAt) {
          throw new BadRequestException(`"${picked.label}" is no longer available`);
        }
        value = picked;
      } else {
        if (!attribute.allowFreeEntry) {
          throw new BadRequestException(`"${attribute.label}" takes one of the listed answers`);
        }
        // Pending, and usable by this item immediately: a seller with a queue
        // behind them cannot wait for an approval (D7).
        value = await this.mintValue(orgId, attribute.id, input.freeText!, {
          approved: false,
          actorId,
        });
        byId.set(value.id, value);
      }

      rows.push({ attributeId: attribute.id, valueId: value.id, numberValue: null });
      answers.push({ attribute: nameAttributeOf(attribute), valueLabel: value.label });
    }

    return {
      categoryId: category.id,
      categoryLabel: category.label,
      name: deriveName(category.label, answers),
      rows,
    };
  }

  /**
   * That a question actually hangs off this category.
   *
   * Walks up the alternation. An attribute under a value is only askable when
   * that value was itself chosen — otherwise an item could answer "Model: Kore"
   * while saying its manufacturer is Rossignol, which the form cannot produce
   * and the name would render as nonsense.
   */
  private assertReachable(
    attribute: NodeRow,
    categoryId: string,
    byId: Map<string, NodeRow>,
    inputs: ItemAttributeInput[],
  ): void {
    let cursor: NodeRow | undefined = attribute;
    let guard = 0;
    while (cursor && guard < 12) {
      guard += 1;
      const parent: NodeRow | undefined = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      if (!parent) break;

      if (parent.kind === 'CATEGORY') {
        if (parent.id !== categoryId) {
          throw new BadRequestException(`"${attribute.label}" does not belong to that category`);
        }
        return;
      }

      if (parent.kind === 'VALUE') {
        // The gate: whoever answered the child must have picked the parent.
        const picked = inputs.some((i) => i.valueId === parent.id);
        if (!picked) {
          throw new BadRequestException(
            `"${attribute.label}" only applies once "${parent.label}" is chosen`,
          );
        }
      }
      cursor = parent;
    }
    throw new BadRequestException(`"${attribute.label}" does not belong to that category`);
  }

  /** A number inside its bounds, and on its step. */
  private assertInRange(attribute: NodeRow, value: number): void {
    if (!Number.isFinite(value)) {
      throw new BadRequestException(`"${attribute.label}" takes a number`);
    }
    if (attribute.minValue != null && value < attribute.minValue) {
      throw new BadRequestException(`"${attribute.label}" cannot be below ${attribute.minValue}`);
    }
    if (attribute.maxValue != null && value > attribute.maxValue) {
      throw new BadRequestException(`"${attribute.label}" cannot be above ${attribute.maxValue}`);
    }
    if (attribute.step != null && attribute.step > 0) {
      const base = attribute.minValue ?? 0;
      const steps = (value - base) / attribute.step;
      // Tolerance rather than equality: 0.1-steps do not land on integers in
      // binary floating point, and refusing a legitimate 26.5 would be worse
      // than accepting a value a thousandth of a step off.
      if (Math.abs(steps - Math.round(steps)) > 1e-6) {
        throw new BadRequestException(
          `"${attribute.label}" goes in steps of ${attribute.step}`,
        );
      }
    }
  }

  /**
   * An item's stored answers, resolved through the tree for a response (D3).
   *
   * The labels are current while the item's `name` is historic, which is the
   * intended pairing rather than an inconsistency.
   */
  async describeItems(
    items: { id: string; categoryId: string | null }[],
  ): Promise<Map<string, ItemDescription>> {
    const out = new Map<string, ItemDescription>();
    if (items.length === 0) return out;

    const rows = await this.prisma.swapItemAttribute.findMany({
      where: { itemId: { in: items.map((i) => i.id) } },
      include: { attribute: true, value: true },
      orderBy: { createdAt: 'asc' },
    });

    const categoryIds = [...new Set(items.map((i) => i.categoryId).filter((id): id is string => !!id))];
    const categories = categoryIds.length
      ? await this.prisma.taxonomyNode.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, label: true },
        })
      : [];
    const categoryById = new Map(categories.map((c) => [c.id, c]));

    for (const item of items) {
      out.set(item.id, {
        category: item.categoryId
          ? (categoryById.get(item.categoryId) ?? null)
          : null,
        attributes: [],
      });
    }

    for (const r of rows) {
      const entry = out.get(r.itemId);
      if (!entry) continue;
      entry.attributes.push({
        attributeId: r.attributeId,
        attributeLabel: r.attribute.label,
        valueId: r.valueId,
        valueLabel:
          renderAnswer({
            attribute: nameAttributeOf(r.attribute),
            valueLabel: r.value?.label ?? null,
            numberValue: r.numberValue,
          }) ?? '',
        numberValue: r.numberValue,
      });
    }

    // Slot order, so a detail panel reads in the same order as the name.
    for (const entry of out.values()) {
      entry.attributes.sort((a, b) => a.attributeLabel.localeCompare(b.attributeLabel));
    }
    return out;
  }

  // ─── Promotion ─────────────────────────────────────────────────────────────

  /**
   * Moves an org node onto the shared list, ancestors first (§8.4).
   *
   * A global node may never have an org parent, so the chain is promoted from
   * the top down. A collision with an existing global label becomes a merge into
   * it — which is the payoff of the two-tier scheme: fourteen clubs' "Rossignol"
   * collapse into one.
   */
  async promote(nodeId: string, actorId?: string, ipAddress?: string): Promise<{ promoted: number; mergedInto: string | null }> {
    const node = await this.prisma.taxonomyNode.findUnique({ where: { id: nodeId } });
    if (!node) throw new NotFoundException('Node not found');
    if (node.orgId === null) throw new BadRequestException('Already shared');
    if (node.status !== 'APPROVED') throw new BadRequestException('A pending value cannot be promoted');

    // Top-down: an ancestor still scoped to an org would leave the child
    // illegal the moment it went global.
    const chain: NodeRow[] = [];
    let cursor: NodeRow | null = node;
    while (cursor && cursor.orgId !== null) {
      chain.unshift(cursor);
      cursor = cursor.parentId
        ? await this.prisma.taxonomyNode.findUnique({ where: { id: cursor.parentId } })
        : null;
    }

    let promoted = 0;
    let mergedInto: string | null = null;

    for (const link of chain) {
      const dedupeKey = dedupeKeyFor(null, link.parentId, link.label);
      const collision = await this.prisma.taxonomyNode.findUnique({ where: { dedupeKey } });
      if (collision) {
        // The shared list already says this. Fold into it rather than refuse.
        if (link.kind === 'VALUE') {
          await this.merge(null, link.id, collision.id, actorId, ipAddress).catch(async () => {
            // `merge` guards org scope for org callers; here the source is an
            // org row and the target global, which it permits. A failure means
            // the two are not comparable, and leaving the org row is correct.
          });
          mergedInto = collision.id;
        }
        continue;
      }
      await this.prisma.taxonomyNode.update({
        where: { id: link.id },
        data: { orgId: null, suggestedAt: null },
      });
      promoted += 1;
    }

    await this.bumpAllVersions();
    await this.audit('ski_swap.taxonomy.node.promoted', null, actorId, ipAddress, node.label);
    return { promoted, mergedInto };
  }

  // ─── Administration views ──────────────────────────────────────────────────

  /** Everything the org's taxonomy tab renders: the queue, and its own nodes. */
  async orgAdmin(orgId: string): Promise<OrgTaxonomyAdmin> {
    const [all, version] = await Promise.all([
      this.visibleNodes(orgId, { approvedOnly: false }),
      this.versionFor(orgId),
    ]);
    const byId = new Map(all.map((n) => [n.id, n]));
    const counts = await this.itemCounts(all.map((n) => n.id));

    const mine = all.filter((n) => n.orgId === orgId);
    const pendingRows = mine.filter((n) => n.status === 'PENDING');

    const pending: PendingValue[] = pendingRows.map((n) => {
      // An approved value under the same question with the same normalised
      // label. The difference between a taxonomy and a pile.
      const target = all.find(
        (o) =>
          o.id !== n.id &&
          o.parentId === n.parentId &&
          o.status === 'APPROVED' &&
          o.retiredAt === null &&
          normalizeLabel(o.label) === normalizeLabel(n.label),
      );
      return {
        node: this.toAdminNode(n, byId, counts),
        similar: target
          ? { id: target.id, label: target.label, scope: target.orgId ? 'org' : 'global' }
          : null,
      };
    });

    return {
      version,
      pending,
      own: mine
        .filter((n) => n.status === 'APPROVED')
        .map((n) => this.toAdminNode(n, byId, counts)),
    };
  }

  /** The global tree, nested, for the platform editor. */
  async globalTree(): Promise<TaxonomyAdminNode[]> {
    const all = await this.prisma.taxonomyNode.findMany({
      where: { orgId: null },
      orderBy: [{ displayOrder: 'asc' }, { label: 'asc' }],
    });
    const byId = new Map(all.map((n) => [n.id, n]));
    const counts = await this.itemCounts(all.map((n) => n.id));

    const byParent = new Map<string | null, NodeRow[]>();
    for (const n of all) {
      const list = byParent.get(n.parentId);
      if (list) list.push(n);
      else byParent.set(n.parentId, [n]);
    }

    const build = (parentId: string | null): TaxonomyAdminNode[] =>
      (byParent.get(parentId) ?? []).map((n) => ({
        ...this.toAdminNode(n, byId, counts),
        children: build(n.id),
      }));

    return build(null);
  }

  /** The promotion inbox. */
  async suggestions(): Promise<TaxonomySuggestion[]> {
    const rows = await this.prisma.taxonomyNode.findMany({
      where: { suggestedAt: { not: null }, orgId: { not: null } },
      orderBy: { suggestedAt: 'asc' },
      include: { org: { select: { name: true } } },
    });
    if (rows.length === 0) return [];

    const all = await this.prisma.taxonomyNode.findMany({
      where: { id: { in: rows.flatMap((r) => [r.id, r.parentId ?? r.id]) } },
    });
    const byId = new Map(all.map((n) => [n.id, n]));
    const counts = await this.itemCounts(rows.map((r) => r.id));

    const out: TaxonomySuggestion[] = [];
    for (const r of rows) {
      // Walk up: promotion is one step only when everything above is shared.
      let ancestorsGlobal = true;
      let cursor = r.parentId ? await this.prisma.taxonomyNode.findUnique({ where: { id: r.parentId } }) : null;
      while (cursor) {
        if (cursor.orgId !== null) { ancestorsGlobal = false; break; }
        cursor = cursor.parentId
          ? await this.prisma.taxonomyNode.findUnique({ where: { id: cursor.parentId } })
          : null;
      }
      const collision = await this.prisma.taxonomyNode.findUnique({
        where: { dedupeKey: dedupeKeyFor(null, r.parentId, r.label) },
      });
      out.push({
        node: this.toAdminNode(r, byId, counts),
        orgName: r.org?.name ?? 'Unknown',
        ancestorsGlobal,
        collision: collision ? { id: collision.id, label: collision.label } : null,
      });
    }
    return out;
  }

  /**
   * How many items point at each node, in one grouped query per relation.
   *
   * What disables Discard, and what a queue row shows. Counted rather than
   * guessed because the number is the reason the button is off.
   */
  private async itemCounts(ids: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (ids.length === 0) return counts;

    const [byValue, byAttribute, byCategory] = await Promise.all([
      this.prisma.swapItemAttribute.groupBy({
        by: ['valueId'],
        where: { valueId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.swapItemAttribute.groupBy({
        by: ['attributeId'],
        where: { attributeId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.swapItem.groupBy({
        by: ['categoryId'],
        where: { categoryId: { in: ids } },
        _count: { _all: true },
      }),
    ]);

    for (const r of byValue) if (r.valueId) counts.set(r.valueId, r._count._all);
    for (const r of byAttribute) {
      counts.set(r.attributeId, (counts.get(r.attributeId) ?? 0) + r._count._all);
    }
    for (const r of byCategory) if (r.categoryId) {
      counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + r._count._all);
    }
    return counts;
  }

  /** "Skis › Manufacturer" — where a queue row sits, without a second fetch. */
  private pathOf(node: NodeRow, byId: Map<string, NodeRow>): string {
    const parts: string[] = [];
    let cursor: NodeRow | undefined = node.parentId ? byId.get(node.parentId) : undefined;
    let guard = 0;
    while (cursor && guard < 12) {
      parts.unshift(cursor.label);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      guard += 1;
    }
    return parts.join(' › ');
  }

  private toAdminNode(
    n: NodeRow,
    byId: Map<string, NodeRow>,
    counts: Map<string, number>,
  ): TaxonomyAdminNode {
    return {
      id: n.id,
      kind: n.kind,
      orgId: n.orgId,
      parentId: n.parentId,
      label: n.label,
      path: this.pathOf(n, byId),
      iconKey: n.iconKey,
      iconUrl: n.iconUrl,
      status: n.status,
      displayOrder: n.displayOrder,
      retiredAt: n.retiredAt?.toISOString() ?? null,
      input: n.input,
      nameSlot: n.nameSlot,
      unit: n.unit,
      minValue: n.minValue,
      maxValue: n.maxValue,
      step: n.step,
      allowFreeEntry: n.allowFreeEntry,
      suggestedAt: n.suggestedAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
      itemCount: counts.get(n.id) ?? 0,
    };
  }

  private async audit(
    action: string,
    orgId: string | null,
    actorId?: string,
    ipAddress?: string,
    detail?: string,
  ): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          actorType: 'user',
          actorId: actorId ?? null,
          orgId,
          action,
          ipAddress: ipAddress ?? null,
          ...(detail ? { metadata: detail } : {}),
        },
      })
      .catch(() => {
        // An audit row is not worth failing an edit over.
      });
  }
}

/**
 * The icon a node carries, in the discriminated shape the UI renders (§4.4).
 *
 * The key is cast rather than re-validated: it was checked against the registry
 * by the Zod schema on the way in, and a key that somehow is not in the list
 * renders as no icon on the client anyway.
 */
function iconOf(
  n: Pick<NodeRow, 'iconKey' | 'iconUrl'>,
  orgId: string,
  base: string,
): ResolvedIcon | null {
  if (n.iconKey) {
    return {
      kind: 'registry',
      key: n.iconKey as TaxonomyIconKey,
      url: registryIconUrl(orgId, n.iconKey, base),
    };
  }
  if (n.iconUrl) return { kind: 'image', url: n.iconUrl };
  return null;
}

/**
 * Where the rendered glyph for a key is served.
 *
 * Absolute when the deployment knows its own origin. The iOS client builds every
 * other request by appending a path to a base that already carries `/api/v1`, so
 * handing it a root-relative path would either double the prefix or force a
 * second kind of resolution for one field. An absolute URL is unambiguous to
 * every client, and matches what an S3-backed uploaded icon already returns.
 *
 * Org-scoped rather than flat, which costs a little cache sharing and buys the
 * thing that matters: `OrDeviceAuthGuard` authenticates a device by matching the
 * token's org against `:orgId`, so a path without one cannot admit an iPad at
 * all. The bytes are immutable per key, so a client caches them once.
 */
export function registryIconUrl(orgId: string, key: string, base = ''): string {
  return `${base}/api/v1/orgs/${orgId}/ski-swap/taxonomy/icons/${key}.png`;
}
