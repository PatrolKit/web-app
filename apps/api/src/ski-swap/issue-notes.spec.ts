import { Reflector } from '@nestjs/core';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PERMISSIONS_KEY } from '../common/decorators/require-permissions.decorator';
import { IssueNotesController } from './issue-notes.controller';
import { IssueNotesService } from './issue-notes.service';

/** Notes on Reports issues (Plan 48): one per issue, kept by page, every write audited. */

function harness() {
  const rows: Record<string, unknown>[] = [];
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const key = (w: { swapId_page_issueKey: { swapId: string; page: string; issueKey: string } }) => w.swapId_page_issueKey;
  const find = (w: { swapId: string; page: string; issueKey: string }) => rows.find((r) => r.swapId === w.swapId && r.page === w.page && r.issueKey === w.issueKey);
  const prisma = {
    skiSwap: { findFirst: async ({ where }: { where: { id: string; orgId: string } }) => (where.orgId === 'org' ? { id: where.id } : null) },
    swapIssueNote: {
      findMany: async ({ where }: { where: { swapId: string; page: string } }) => rows.filter((r) => r.swapId === where.swapId && r.page === where.page),
      findUnique: async ({ where }: { where: Parameters<typeof key>[0] }) => find(key(where)) ?? null,
      delete: async ({ where }: { where: Parameters<typeof key>[0] }) => { rows.splice(rows.indexOf(find(key(where))!), 1); },
      upsert: async ({ where, update, create }: { where: Parameters<typeof key>[0]; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const row = find(key(where));
        if (row) Object.assign(row, update, { updatedAt: new Date('2026-10-10T19:05:00Z') });
        else rows.push({ ...create, updatedAt: new Date('2026-10-10T19:00:00Z') });
        return find(key(where));
      },
    },
    user: { findMany: async () => [{ id: 'staff', firstName: 'Dana', lastName: 'Reyes', email: null }] },
    auditLog: { create: async ({ data }: { data: { action: string; metadata: Record<string, unknown> } }) => { audits.push(data); } },
  };
  return { service: new IssueNotesService(prisma as never), rows, audits };
}

describe('issue notes', () => {
  it('saves a note, edits it, and lists it by key with who wrote it', async () => {
    const h = harness();
    await expect(h.service.save('org', 'swap', 'sales', { issueKey: 'o1:l1', text: '  Stub says Karen; ask Mike.  ' }, 'staff'))
      .resolves.toMatchObject({ text: 'Stub says Karen; ask Mike.', updatedByName: 'Dana Reyes' });
    await h.service.save('org', 'swap', 'sales', { issueKey: 'o1:l1', text: 'Mike says refund it.' }, 'staff');
    await expect(h.service.list('org', 'swap', 'sales')).resolves.toEqual({
      'o1:l1': { text: 'Mike says refund it.', updatedByName: 'Dana Reyes', updatedAt: '2026-10-10T19:05:00.000Z' },
    });
    expect(h.audits.map((a) => [a.action, a.metadata.before])).toEqual([
      ['ski_swap.issue_note.saved', null],
      ['ski_swap.issue_note.saved', 'Stub says Karen; ask Mike.'],
    ]);
  });

  it('keeps the two pages apart, and clears a note for an empty text', async () => {
    const h = harness();
    await h.service.save('org', 'swap', 'catalog', { issueKey: '73593|stock|', text: 'Counted it: on the floor.' }, 'staff');
    await expect(h.service.list('org', 'swap', 'sales')).resolves.toEqual({});
    await expect(h.service.save('org', 'swap', 'catalog', { issueKey: '73593|stock|', text: '   ' }, 'staff')).resolves.toBeNull();
    await expect(h.service.list('org', 'swap', 'catalog')).resolves.toEqual({});
    expect(h.audits.map((a) => a.action)).toEqual(['ski_swap.issue_note.saved', 'ski_swap.issue_note.cleared']);
  });

  it('refuses another org’s swap', async () => {
    await expect(harness().service.list('other', 'swap', 'sales')).rejects.toThrow('Swap not found');
  });
});

describe('the issue note routes', () => {
  const reflector = new Reflector();
  const route = (name: keyof IssueNotesController) => [
    Reflect.getMetadata(METHOD_METADATA, IssueNotesController.prototype[name]),
    reflector.get(PERMISSIONS_KEY, IssueNotesController.prototype[name]),
  ];

  it('let anyone who reads Sales check write its notes, and keep Catalog check’s for admins', () => {
    expect(route('sales')).toEqual([RequestMethod.GET, ['ski_swap:report']]);
    expect(route('saveSales')).toEqual([RequestMethod.PUT, ['ski_swap:report']]);
    expect(route('catalog')).toEqual([RequestMethod.GET, ['ski_swap:admin']]);
    expect(route('saveCatalog')).toEqual([RequestMethod.PUT, ['ski_swap:admin']]);
  });
});
