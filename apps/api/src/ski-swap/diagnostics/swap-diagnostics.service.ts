import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PosAdapterFactory, type IPosAdapter, type PosItemSync } from '../pos/pos.adapter';
import { ItemService } from '../item.service';
import { SELLER_NAME_INCLUDE, sellerDisplayName } from '../seller.service';
import { ticketNumberOf } from '../legacy-ticket.service';
import { displayName } from '../../common/util/person';
import {
  CHOICES_FOR,
  type DiagnosticApplyAllResponse,
  type DiagnosticChoice,
  type DiagnosticIssueResponse,
  type DiagnosticRunResponse,
} from '../../contracts/swap-diagnostics.contracts';
import {
  diagnose, issueKey,
  type FoundIssue, type IssueKind, type OurDeletedItem, type OurItem, type OurSide, type SquareSide,
} from './diagnose';

/** A run still marked running this long after its last update was cut off (D9). */
const STALE_MS = 10 * 60 * 1000;
/** Runs kept per swap (D10). */
const KEPT_RUNS = 30;

type Swap = { id: string; orgId: string; title: string; squareCategoryId: string; locationId: string };
type IssueRow = Prisma.SwapDiagnosticIssueGetPayload<object>;
type Extra = { sellerId?: string; restoreItemId?: string; keepSquareItemId?: string };

/**
 * Swap diagnostics (Plan 41): a run compares our items with the swap's Square
 * category, matched by SKU, and records every disagreement as an issue. Staff
 * choose what to do about each; nothing changes until they do.
 */
@Injectable()
export class SwapDiagnosticsService {
  private readonly logger = new Logger(SwapDiagnosticsService.name);
  /** Swaps with a start in flight, so two clicks make one run. */
  private readonly starting = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly posFactory: PosAdapterFactory,
    private readonly items: ItemService,
  ) {}

  // ─── Runs ───────────────────────────────────────────────────────────────────

  /** Starts a run, or answers the one already going (D9). The run goes on without the caller. */
  async start(orgId: string, swapId: string, userId: string | null): Promise<{ runId: string }> {
    const swap = await this.swapOrThrow(orgId, swapId);
    const running = await this.prisma.swapDiagnosticRun.findFirst({
      where: { swapId, status: 'running' },
      orderBy: { startedAt: 'desc' },
    });
    if (running && !isStale(running)) return { runId: running.id };
    if (this.starting.has(swapId)) throw new ConflictException('A check is starting. Give it a moment.');

    this.starting.add(swapId);
    try {
      if (running) {
        await this.prisma.swapDiagnosticRun.update({
          where: { id: running.id },
          data: { status: 'failed', error: 'Interrupted: the server restarted while it ran.' },
        });
      }
      const run = await this.prisma.swapDiagnosticRun.create({
        data: { orgId, swapId, startedBy: userId, status: 'running' },
      });
      void this.execute(swap, run.id).catch(async (err: unknown) => {
        this.logger.error({ err, swapId, runId: run.id }, 'Swap diagnostics run failed');
        await this.prisma.swapDiagnosticRun.update({
          where: { id: run.id },
          data: { status: 'failed', finishedAt: new Date(), error: messageOf(err) },
        }).catch(() => undefined);
      });
      return { runId: run.id };
    } finally {
      this.starting.delete(swapId);
    }
  }

  private async execute(swap: Swap, runId: string): Promise<void> {
    const pos = await this.posOrThrow(swap);

    // Progress per page, written in order and awaited before the end, so the
    // last count can't land after "done".
    let progress = Promise.resolve();
    const square = await pos.listCategoryItems(swap.squareCategoryId, (done) => {
      progress = progress.then(() =>
        this.prisma.swapDiagnosticRun.update({ where: { id: runId }, data: { done } }).then(() => undefined));
    });
    await progress;

    const { ours, deleted } = await this.ourItems(swap.id);
    const found = diagnose({ ours, deleted, square });
    const hidden = await this.hiddenKeys(swap.id);
    const kept = found.filter((i) => !hidden.has(`${issueKey(i)}\u0000${i.fingerprint}`));

    for (let at = 0; at < kept.length; at += 1000) {
      await this.prisma.swapDiagnosticIssue.createMany({
        data: kept.slice(at, at + 1000).map((i) => ({
          runId, swapId: swap.id, sku: i.sku, kind: i.kind, field: i.field,
          ours: i.ours ? (i.ours as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          square: i.square ? (i.square as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          fingerprint: i.fingerprint,
        })),
      });
    }
    await this.prisma.swapDiagnosticRun.update({
      where: { id: runId },
      data: {
        status: 'done', finishedAt: new Date(), done: square.length,
        ourCount: ours.length, squareCount: new Set(square.map((s) => s.itemId)).size,
      },
    });
    await this.prune(swap.id);
  }

  private async prune(swapId: string): Promise<void> {
    const old = await this.prisma.swapDiagnosticRun.findMany({
      where: { swapId },
      orderBy: { startedAt: 'desc' },
      skip: KEPT_RUNS,
      select: { id: true },
    });
    if (old.length) await this.prisma.swapDiagnosticRun.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
  }

  /** The latest run with its issues (D9), or null before the first. */
  async latest(orgId: string, swapId: string): Promise<DiagnosticRunResponse | null> {
    await this.swapOrThrow(orgId, swapId);
    const run = await this.prisma.swapDiagnosticRun.findFirst({
      where: { orgId, swapId },
      orderBy: { startedAt: 'desc' },
      include: { issues: { orderBy: [{ kind: 'asc' }, { field: 'asc' }, { sku: 'asc' }] } },
    });
    if (!run) return null;
    const names = await this.userNames([run.startedBy, ...run.issues.map((i) => i.decidedBy)]);
    return {
      id: run.id,
      status: run.status === 'running' && isStale(run) ? 'interrupted' : (run.status as DiagnosticRunResponse['status']),
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      startedByName: run.startedBy ? names.get(run.startedBy) ?? null : null,
      done: run.done,
      ourCount: run.ourCount,
      squareCount: run.squareCount,
      error: run.error,
      issues: run.issues.map((i) => toIssueResponse(i, names)),
    };
  }

  // ─── Choices ────────────────────────────────────────────────────────────────

  /** One issue's choice (D3), refused when the issue changed since the run (D6). */
  async apply(orgId: string, swapId: string, issueId: string, choice: DiagnosticChoice, extra: Extra, userId: string | null): Promise<DiagnosticIssueResponse> {
    const swap = await this.swapOrThrow(orgId, swapId);
    const issue = await this.prisma.swapDiagnosticIssue.findFirst({ where: { id: issueId, swapId } });
    if (!issue) throw new NotFoundException('That issue is gone. Run the checks again.');
    if (issue.state !== 'open' && issue.state !== 'failed') throw new ConflictException('That issue was already dealt with.');

    const { skipped } = await this.applyTo(swap, [issue], choice, extra, userId);
    if (skipped) throw new ConflictException('This changed since the check ran. Run the checks again.');
    const updated = await this.prisma.swapDiagnosticIssue.findUniqueOrThrow({ where: { id: issueId } });
    return toIssueResponse(updated, await this.userNames([updated.decidedBy]));
  }

  /** One choice for every open issue in a group (D4). Changed ones are skipped. */
  async applyAll(
    orgId: string, swapId: string, runId: string,
    group: { kind: IssueKind; field?: string }, choice: DiagnosticChoice, extra: Extra, userId: string | null,
  ): Promise<DiagnosticApplyAllResponse> {
    const swap = await this.swapOrThrow(orgId, swapId);
    if (choice === 'keep') throw new BadRequestException('Keep this copy is chosen one item at a time.');
    const issues = await this.prisma.swapDiagnosticIssue.findMany({
      where: {
        runId, swapId, kind: group.kind,
        field: group.kind === 'differs' ? (group.field ?? null) : null,
        state: { in: ['open', 'failed'] },
      },
    });
    const { applied, skipped, failed } = await this.applyTo(swap, issues, choice, extra, userId);
    return { applied, skipped, failed };
  }

  private async applyTo(swap: Swap, issues: IssueRow[], choice: DiagnosticChoice, extra: Extra, userId: string | null) {
    const tally = { applied: 0, skipped: 0, failed: 0 };
    if (issues.length === 0) return tally;
    for (const issue of issues) {
      if (!CHOICES_FOR[issue.kind as IssueKind]?.includes(choice)) {
        throw new BadRequestException('That choice doesn’t apply to this issue.');
      }
    }

    // Both sides, as they are now, for every SKU involved.
    const current = await this.recheck(swap, [...new Set(issues.map((i) => i.sku))]);
    const outcomes: { issue: IssueRow; state: 'applied' | 'fixed' | 'left' | 'failed'; error?: string }[] = [];

    if (choice === 'resolve') {
      // Mark resolved changes nothing (D5): it records whether the sides now
      // agree, and if they don't, hides the values as they are now.
      for (const issue of issues) {
        const now = current.get(issueKey(issue));
        if (now) {
          await this.prisma.swapDiagnosticHidden.upsert({
            where: { swapId_sku_kind_field_fingerprint: { swapId: swap.id, sku: issue.sku, kind: issue.kind, field: issue.field ?? '', fingerprint: now.fingerprint } },
            update: {},
            create: { swapId: swap.id, sku: issue.sku, kind: issue.kind, field: issue.field ?? '', fingerprint: now.fingerprint, hiddenBy: userId },
          });
        }
        outcomes.push({ issue, state: now ? 'left' : 'fixed' });
      }
    } else {
      // Anything else only on the data the run saw (D6).
      const fresh = issues.filter((i) => current.get(issueKey(i))?.fingerprint === i.fingerprint);
      tally.skipped = issues.length - fresh.length;
      if (fresh.length) outcomes.push(...(await this.perform(swap, fresh, choice, extra)));
    }

    const now = new Date();
    for (const o of outcomes) {
      await this.prisma.swapDiagnosticIssue.update({
        where: { id: o.issue.id },
        data: { state: o.state, choice, decidedBy: userId, decidedAt: now, error: o.error ?? null },
      });
      if (o.state === 'failed') tally.failed++;
      else tally.applied++;
    }
    const done = outcomes.filter((o) => o.state !== 'failed');
    if (done.length) {
      await this.prisma.auditLog.createMany({
        data: done.map((o) => ({
          actorType: 'user', actorId: userId, orgId: swap.orgId, action: 'ski_swap.diagnostics.applied',
          metadata: {
            swapId: swap.id, sku: o.issue.sku, kind: o.issue.kind, field: o.issue.field, choice, outcome: o.state,
            ours: o.issue.ours, square: o.issue.square,
          } as Prisma.InputJsonValue,
        })),
      });
    }
    return tally;
  }

  /** What each choice does (D3), for issues checked as unchanged. */
  private async perform(swap: Swap, issues: IssueRow[], choice: DiagnosticChoice, extra: Extra) {
    const out: { issue: IssueRow; state: 'applied' | 'failed'; error?: string }[] = [];
    const each = async (fn: (issue: IssueRow) => Promise<void>) => {
      for (const issue of issues) {
        try {
          await fn(issue);
          out.push({ issue, state: 'applied' });
        } catch (err) {
          out.push({ issue, state: 'failed', error: messageOf(err) });
        }
      }
    };

    switch (choice) {
      case 'copy_to_square':
      case 'use_ours': {
        // Square writes in bulk (D7): our item's details, to a new Square item
        // or (Use ours) to the one it was compared with.
        const pos = await this.posOrThrow(swap);
        const ours = await this.prisma.swapItem.findMany({
          where: { id: { in: issues.map((i) => ourOf(i)!.itemId) }, swapId: swap.id, deletedAt: null },
        });
        const byId = new Map(ours.map((o) => [o.id, o]));
        const sendable = issues.filter((i) => byId.has(ourOf(i)!.itemId));
        for (const i of issues) if (!byId.has(ourOf(i)!.itemId)) out.push({ issue: i, state: 'failed', error: 'That item was deleted.' });
        const sync: PosItemSync[] = sendable.map((i) => {
          const o = byId.get(ourOf(i)!.itemId)!;
          const target = choice === 'use_ours' ? squareOf(i) : null;
          return {
            posItemId: target?.itemId ?? o.squareItemId ?? undefined,
            posVariationId: target?.variationId ?? o.squareVariationId ?? undefined,
            name: o.name, description: o.description ?? undefined, priceCents: o.priceCents, sku: o.sku,
            categoryId: swap.squareCategoryId, categoryName: swap.title,
          };
        });
        const { results, resolvedCategoryId } = await pos.upsertItems(sync, swap.locationId, 1);
        if (resolvedCategoryId && resolvedCategoryId !== swap.squareCategoryId) {
          await this.prisma.skiSwap.update({ where: { id: swap.id }, data: { squareCategoryId: resolvedCategoryId } });
        }
        for (const [n, issue] of sendable.entries()) {
          const r = results[n];
          if ('error' in r) { out.push({ issue, state: 'failed', error: r.error }); continue; }
          // Copy to Square links the new item. Use ours leaves the link alone:
          // linking is its own choice (Not linked).
          if (choice === 'copy_to_square') {
            await this.prisma.swapItem.update({
              where: { id: ourOf(issue)!.itemId },
              data: { squareItemId: r.posItemId, squareVariationId: r.posVariationId, lastSyncedAt: new Date() },
            });
          }
          out.push({ issue, state: 'applied' });
        }
        return out;
      }

      case 'use_square':
        // Written straight to the item, not through the item edit: an edit
        // pushes to Square by the stored ids, and on an item not linked that
        // would make a second copy. `updatedAt` moves, so the iPads get it.
        await each(async (issue) => {
          const sq = squareOf(issue)!;
          const ours = ourOf(issue)!;
          const data: Prisma.SwapItemUpdateInput =
            issue.field === 'name' ? { name: sq.name }
              : issue.field === 'notes' ? { description: sq.notes }
                : { priceCents: sq.priceCents };
          if (issue.field === 'price' && sq.priceCents === null && ticketNumberOf(issue.sku) === null) {
            throw new BadRequestException('Only a ticket can be without a price.');
          }
          await this.prisma.swapItem.update({ where: { id: ours.itemId }, data });
        });
        return out;

      case 'link':
        await each(async (issue) => {
          const sq = squareOf(issue)!;
          await this.prisma.swapItem.update({
            where: { id: ourOf(issue)!.itemId },
            data: { squareItemId: sq.itemId, squareVariationId: sq.variationId, lastSyncedAt: new Date() },
          });
        });
        return out;

      case 'keep':
        await each(async (issue) => {
          const copies = (issue.square as unknown as { copies: SquareSide[] } | null)?.copies ?? [];
          const kept = copies.find((c) => c.itemId === extra.keepSquareItemId);
          if (!kept) throw new BadRequestException('Pick one of the copies to keep.');
          const ours = ourOf(issue);
          if (ours) {
            await this.prisma.swapItem.update({
              where: { id: ours.itemId },
              data: { squareItemId: kept.itemId, squareVariationId: kept.variationId, lastSyncedAt: new Date() },
            });
          }
          const pos = await this.posOrThrow(swap);
          await pos.deleteItems(copies.filter((c) => c !== kept).map((c) => c.itemId));
        });
        return out;

      case 'copy_to_patrolkit':
        await each(async (issue) => {
          const sq = squareOf(issue)!;
          const deleted = ourOf(issue)?.deleted ? ourOf(issue)! : null;
          // One at a time, the choice names the deleted item to restore; for a
          // whole group, a deleted item is restored wherever there is one.
          const restore = issues.length === 1 ? extra.restoreItemId === deleted?.itemId && !!deleted : !!deleted;
          if (restore) {
            await this.prisma.swapItem.update({
              where: { id: deleted!.itemId },
              data: {
                deletedAt: null, liveSku: issue.sku, consignedAt: new Date(),
                squareItemId: sq.itemId, squareVariationId: sq.variationId, lastSyncedAt: new Date(),
              },
            });
            return;
          }
          if (!extra.sellerId) throw new BadRequestException('Pick the seller this item belongs to.');
          if (sq.priceCents === null && ticketNumberOf(issue.sku) === null) {
            throw new BadRequestException('Square has no price for this, and only a ticket can be without one.');
          }
          await this.items.create(swap.orgId, swap.id, {
            sku: issue.sku,
            fallbackName: sq.name,
            ...(sq.notes ? { description: sq.notes } : {}),
            priceCents: sq.priceCents,
            quantity: 1,
            sellerId: extra.sellerId,
            squareIds: { itemId: sq.itemId, variationId: sq.variationId },
          });
        });
        return out;

      default:
        throw new BadRequestException('That choice doesn’t apply here.');
    }
  }

  // ─── Reading both sides ────────────────────────────────────────────────────

  /** The issues these SKUs have right now, re-read from both sides, by key. */
  private async recheck(swap: Swap, skus: string[]): Promise<Map<string, FoundIssue>> {
    const pos = await this.posOrThrow(swap);
    const square = await pos.itemsBySku(swap.squareCategoryId, skus);
    const { ours, deleted } = await this.ourItems(swap.id, skus);
    const found = diagnose({ ours, deleted, square, onlySkus: new Set(skus) });
    return new Map(found.map((i) => [issueKey(i), i]));
  }

  private async ourItems(swapId: string, skus?: string[]): Promise<{ ours: OurItem[]; deleted: OurDeletedItem[] }> {
    const rows = await this.prisma.swapItem.findMany({
      where: { swapId, ...(skus ? { sku: { in: skus } } : {}) },
      select: {
        id: true, sku: true, name: true, description: true, priceCents: true, consignedAt: true, deletedAt: true,
        squareItemId: true, squareVariationId: true,
        seller: { include: SELLER_NAME_INCLUDE },
      },
    });
    const ours: OurItem[] = [];
    const deleted: OurDeletedItem[] = [];
    for (const r of rows) {
      const sellerName = sellerDisplayName(r.seller);
      if (r.deletedAt) {
        deleted.push({ id: r.id, sku: r.sku, name: r.name, sellerName });
      } else {
        ours.push({
          id: r.id, sku: r.sku, name: r.name, description: r.description, priceCents: r.priceCents,
          consigned: r.consignedAt !== null, squareItemId: r.squareItemId, squareVariationId: r.squareVariationId, sellerName,
        });
      }
    }
    return { ours, deleted };
  }

  private async hiddenKeys(swapId: string): Promise<Set<string>> {
    const rows = await this.prisma.swapDiagnosticHidden.findMany({ where: { swapId } });
    return new Set(rows.map((h) =>
      `${issueKey({ sku: h.sku, kind: h.kind, field: h.field || null })}\u0000${h.fingerprint}`));
  }

  private async swapOrThrow(orgId: string, swapId: string): Promise<Swap> {
    const swap = await this.prisma.skiSwap.findFirst({
      where: { id: swapId, orgId },
      select: { id: true, orgId: true, title: true, squareCategoryId: true, locationId: true },
    });
    if (!swap) throw new NotFoundException('Swap not found');
    return swap;
  }

  private async posOrThrow(swap: Swap): Promise<IPosAdapter> {
    if (!swap.squareCategoryId || !swap.locationId) {
      throw new BadRequestException('This swap isn’t connected to Square yet.');
    }
    const pos = await this.posFactory.forOrg(swap.orgId);
    if (!pos) throw new BadRequestException('Square isn’t connected for this organization.');
    return pos;
  }

  private async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    return new Map(users.map((u) => [u.id, displayName(u)]));
  }
}

function isStale(run: { status: string; updatedAt: Date }): boolean {
  return run.status === 'running' && Date.now() - run.updatedAt.getTime() > STALE_MS;
}

function ourOf(issue: IssueRow): (OurSide & { deleted?: boolean }) | null {
  return (issue.ours as unknown as (OurSide & { deleted?: boolean }) | null) ?? null;
}

function squareOf(issue: IssueRow): SquareSide | null {
  const sq = issue.square as unknown as SquareSide | { copies: SquareSide[] } | null;
  return sq && !('copies' in sq) ? sq : null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function toIssueResponse(i: IssueRow, names: Map<string, string>): DiagnosticIssueResponse {
  return {
    id: i.id,
    sku: i.sku,
    kind: i.kind as DiagnosticIssueResponse['kind'],
    field: (i.field as DiagnosticIssueResponse['field']) ?? null,
    ours: (i.ours as unknown as DiagnosticIssueResponse['ours']) ?? null,
    square: (i.square as unknown as DiagnosticIssueResponse['square']) ?? null,
    state: i.state as DiagnosticIssueResponse['state'],
    choice: (i.choice as DiagnosticChoice | null) ?? null,
    decidedByName: i.decidedBy ? names.get(i.decidedBy) ?? null : null,
    decidedAt: i.decidedAt?.toISOString() ?? null,
    error: i.error,
  };
}
