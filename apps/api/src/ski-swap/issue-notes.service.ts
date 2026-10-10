import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { IssueNote, IssueNotePage, IssueNotesResponse } from '../contracts/issue-notes.contracts';

/**
 * Notes on Reports issues (Plan 48): a person's findings, kept with the swap
 * by page and issue key. Writing one changes nothing in Square or the sales;
 * every write is audited, which is its history.
 */
@Injectable()
export class IssueNotesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(orgId: string, swapId: string, page: IssueNotePage): Promise<IssueNotesResponse> {
    await this.swapOrThrow(orgId, swapId);
    const rows = await this.prisma.swapIssueNote.findMany({ where: { swapId, page } });
    const names = await this.userNames(rows.map((r) => r.updatedBy));
    return Object.fromEntries(rows.map((r) => [r.issueKey, {
      text: r.text, updatedByName: r.updatedBy ? names.get(r.updatedBy) ?? null : null, updatedAt: r.updatedAt.toISOString(),
    }]));
  }

  /** Saves the note, or clears it for an empty text. Answers the note as saved, or null. */
  async save(orgId: string, swapId: string, page: IssueNotePage, body: { issueKey: string; text: string }, userId: string): Promise<IssueNote | null> {
    await this.swapOrThrow(orgId, swapId);
    const text = body.text.trim();
    const where = { swapId_page_issueKey: { swapId, page, issueKey: body.issueKey } };
    // Read before writing: the audit keeps what the note said.
    const before = (await this.prisma.swapIssueNote.findUnique({ where, select: { text: true } }))?.text ?? null;
    if (!text) {
      if (before !== null) {
        await this.prisma.swapIssueNote.delete({ where });
        await this.audit(orgId, userId, 'ski_swap.issue_note.cleared', { swapId, page, issueKey: body.issueKey, before });
      }
      return null;
    }
    const row = await this.prisma.swapIssueNote.upsert({
      where,
      update: { text, updatedBy: userId },
      create: { swapId, orgId, page, issueKey: body.issueKey, text, updatedBy: userId },
    });
    await this.audit(orgId, userId, 'ski_swap.issue_note.saved', { swapId, page, issueKey: body.issueKey, text, before });
    const names = await this.userNames([userId]);
    return { text: row.text, updatedByName: names.get(userId) ?? null, updatedAt: row.updatedAt.toISOString() };
  }

  private async swapOrThrow(orgId: string, swapId: string) {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { id: true } });
    if (!swap) throw new NotFoundException('Swap not found');
    return swap;
  }

  private async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (want.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: want } }, select: { id: true, firstName: true, lastName: true, email: true } });
    return new Map(users.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Someone']));
  }

  private async audit(orgId: string, userId: string, action: string, metadata: Record<string, unknown>) {
    await this.prisma.auditLog.create({
      data: { actorType: 'user', actorId: userId, orgId, action, metadata: metadata as Prisma.InputJsonValue },
    });
  }
}
