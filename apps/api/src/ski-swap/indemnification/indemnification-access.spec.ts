import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { IndemnificationAccessGuard, accessOf, refusalOf } from './indemnification-access';
import { IndemnificationController } from './indemnification.controller';
import { IndemnificationImportService } from './indemnification-import.service';
import { SkiSwapSettingsService } from '../ski-swap-settings.service';

/**
 * Binding indemnification, allowed per org by the platform and on per org for
 * the web and the iPads (Plan 51). The lists are licensed: every way in is
 * refused unless both say yes for the client asking.
 */

describe('who may read the lists', () => {
  it('is no one while the platform hasn’t allowed the org, whatever its switches say', () => {
    expect(accessOf({ indemnificationAllowed: false }, { indemnificationWeb: true, indemnificationIpad: true })).toEqual({ allowed: false, web: false, ipad: false });
    expect(accessOf(null, null)).toEqual({ allowed: false, web: false, ipad: false });
  });

  it('is the web and the iPads each as the org switched them, once allowed', () => {
    expect(accessOf({ indemnificationAllowed: true }, { indemnificationWeb: true, indemnificationIpad: false })).toEqual({ allowed: true, web: true, ipad: false });
  });

  it('says why a client is refused', () => {
    expect(refusalOf({ allowed: false, web: false, ipad: false }, 'web')).toMatch(/isn’t available to this organization/);
    expect(refusalOf({ allowed: true, web: true, ipad: false }, 'ipad')).toMatch(/iPads/);
    expect(refusalOf({ allowed: true, web: false, ipad: true }, 'web')).toMatch(/on the web/);
    expect(refusalOf({ allowed: true, web: true, ipad: true }, 'ipad')).toBeNull();
  });
});

describe('the lookup routes', () => {
  const guard = (org: { indemnificationAllowed: boolean } | null, s: { indemnificationWeb: boolean; indemnificationIpad: boolean } | null) =>
    new IndemnificationAccessGuard({
      organization: { findUnique: async () => org },
      skiSwapSettings: { findUnique: async () => s },
    } as never);
  const ctx = (device: boolean) => ({
    switchToHttp: () => ({ getRequest: () => ({ params: { orgId: 'org-1' }, ...(device ? { device: { deviceId: 'd' } } : {}) }) }),
  }) as never;

  it('carry the access guard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, IndemnificationController)).toContain(IndemnificationAccessGuard);
  });

  it('let a person through for the web, and an iPad for the iPads, each only as switched', async () => {
    const webOnly = guard({ indemnificationAllowed: true }, { indemnificationWeb: true, indemnificationIpad: false });
    await expect(webOnly.canActivate(ctx(false))).resolves.toBe(true);
    await expect(webOnly.canActivate(ctx(true))).rejects.toMatchObject({ response: { code: 'INDEMNIFICATION_OFF' } });
  });

  it('refuse both while the org isn’t allowed', async () => {
    const off = guard({ indemnificationAllowed: false }, { indemnificationWeb: true, indemnificationIpad: true });
    await expect(off.canActivate(ctx(false))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(off.canActivate(ctx(true))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('an org admin’s switches', () => {
  function harness(allowed: boolean, row: Record<string, unknown> | null = null) {
    const audits: { action: string; metadata: Record<string, unknown> }[] = [];
    let stored = row;
    const prisma = {
      organization: { findUnique: async () => ({ indemnificationAllowed: allowed }) },
      skiSwapSettings: {
        findUnique: async () => stored,
        upsert: async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
          stored = { requireConsignmentScan: false, commissionBasisPoints: 0, barcodesPerTicket: 1, showUsBootSizes: false, taxonomyVersion: 1, indemnificationWeb: false, indemnificationIpad: false, indemnificationCertifiedBy: null, indemnificationCertifiedAt: null, ...(stored ?? create), ...update };
          return stored;
        },
      },
      skiSwap: { findFirst: async () => null },
      user: { findUnique: async () => ({ firstName: 'Dana', lastName: 'Smith' }) },
      auditLog: { create: async ({ data }: { data: { action: string; metadata: Record<string, unknown> } }) => { audits.push(data); } },
    };
    return { settings: new SkiSwapSettingsService(prisma as never, { smsEnabled: async () => false } as never), audits };
  }

  it('need the certification to turn either on, and record who certified', async () => {
    const h = harness(true);
    await expect(h.settings.upsert('org-1', { indemnificationIpad: true }, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
    const res = await h.settings.upsert('org-1', { indemnificationIpad: true, certifyIndemnification: true }, 'admin-1');
    expect(res.indemnification).toMatchObject({ allowed: true, web: false, ipad: true, certifiedBy: 'Dana Smith' });
    expect(res.indemnification.certifiedAt).toEqual(expect.any(String));
    expect(res.indemnification.certification).toMatch(/certify that your organization has a right to access this proprietary information/);
    expect(h.audits).toEqual([expect.objectContaining({ action: 'ski_swap.settings.indemnification', metadata: { ipad: { from: false, to: true }, certified: true } })]);
  });

  it('turn off without certifying again', async () => {
    const h = harness(true, { indemnificationWeb: true, indemnificationIpad: true, indemnificationCertifiedBy: 'admin-1', indemnificationCertifiedAt: new Date() });
    const res = await h.settings.upsert('org-1', { indemnificationWeb: false }, 'admin-2');
    expect(res.indemnification).toMatchObject({ web: false, ipad: true });
  });

  it('are refused while the platform hasn’t allowed the org, and read off', async () => {
    const h = harness(false, { indemnificationWeb: true, indemnificationIpad: true, indemnificationCertifiedBy: null, indemnificationCertifiedAt: null });
    await expect(h.settings.upsert('org-1', { indemnificationWeb: false }, 'admin-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect((await h.settings.get('org-1')).indemnification).toMatchObject({ allowed: false, web: false, ipad: false });
  });
});

describe('a platform admin’s allowance', () => {
  it('is set per org, audited, and leaves the org’s own switches as they were', async () => {
    const audits: { action: string; metadata: unknown }[] = [];
    const org = { id: 'org-1', name: 'Patrol', indemnificationAllowed: false, indemnificationAllowedBy: null as string | null, indemnificationAllowedAt: null as Date | null };
    const prisma = {
      organization: {
        findUnique: async () => org,
        update: async ({ data }: { data: Partial<typeof org> }) => Object.assign(org, data),
        findMany: async () => [{ ...org, skiSwapSettings: { indemnificationWeb: true, indemnificationIpad: false, indemnificationCertifiedBy: null, indemnificationCertifiedAt: null } }],
      },
      user: { findMany: async () => [{ id: 'root', firstName: 'Pat', lastName: 'Admin', email: null, phone: null }] },
      auditLog: { create: async ({ data }: { data: { action: string; metadata: unknown } }) => { audits.push(data); } },
    };
    const service = new IndemnificationImportService(prisma as never, {} as never, {} as never);
    const res = await service.setAllowed('org-1', true, 'root');
    expect(res).toMatchObject({ orgId: 'org-1', allowed: true, allowedBy: 'Pat Admin', web: true, ipad: false });
    expect(audits).toEqual([expect.objectContaining({ action: 'ski_swap.indemnification.allowed', metadata: { to: true } })]);
    await service.setAllowed('org-1', true, 'root');
    expect(audits).toHaveLength(1);
  });
});
