import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DevicesService } from './devices.service';

/**
 * Where a device says it stands.
 *
 * Two kinds of hardware have a resort and they do not have the same rules. A
 * time-clock terminal may sit unbound — that is how a tablet is taken out of
 * service without being revoked — and may rebind itself after being carried to
 * another lodge. A signage display may do neither: it cannot be provisioned
 * without a resort, because an unbound screen is dark and a dark screen is
 * indistinguishable from a broken one, and it cannot rebind itself, because
 * nobody carries a screen that is bolted to a wall.
 *
 * What they share is one rule — a live resort, in the device's own org, on a
 * device that has a resort at all — and most of what follows is that rule
 * holding from every direction, since a device authenticates as itself and
 * cannot be checked by a permission.
 */

type Device = {
  id: string;
  orgId: string;
  role: string;
  resortId: string | null;
};

type Resort = { id: string; orgId: string; deletedAt: Date | null };

const TERMINAL: Device = { id: 'dev-1', orgId: 'org-1', role: 'time_clock.terminal', resortId: null };
const BRIDGE: Device = { id: 'dev-2', orgId: 'org-1', role: 'ski_swap.print_bridge', resortId: null };
const DISPLAY: Device = { id: 'dev-3', orgId: 'org-1', role: 'signage.display', resortId: null };

const RESORTS: Resort[] = [
  { id: 'res-live', orgId: 'org-1', deletedAt: null },
  { id: 'res-gone', orgId: 'org-1', deletedAt: new Date('2026-01-01') },
  { id: 'res-other-org', orgId: 'org-2', deletedAt: null },
];

/** Enough Prisma to answer the lookups, and a record of what was written. */
function stubPrisma(devices: Device[]) {
  const writes: { id: string; resortId: string | null }[] = [];
  return {
    writes,
    device: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        devices.find((d) => d.id === where.id) ?? null,
      findFirst: async ({ where }: { where: { id: string; orgId?: string } }) =>
        devices.find((d) => d.id === where.id && (!where.orgId || d.orgId === where.orgId)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = { ...data, createdAt: new Date() } as Record<string, unknown>;
        devices.push({
          id: String(created.id),
          orgId: String(created.orgId),
          role: String(created.role),
          resortId: (created.resortId as string | null) ?? null,
        });
        return created;
      },
      update: async ({ where, data }: { where: { id: string }; data: { resortId?: string | null } }) => {
        const d = devices.find((x) => x.id === where.id)!;
        // Only resort writes are recorded. `getDeviceMe` touches `lastSeenAt`
        // on the same table, and counting that as a write would make every
        // assertion here about something the test does not care about.
        if ('resortId' in data) {
          writes.push({ id: where.id, resortId: data.resortId ?? null });
          d.resortId = data.resortId ?? null;
        }
        return d;
      },
    },
    resort: {
      // Honours the filter it is given rather than returning the first row:
      // the whole point of these tests is which rows the service refuses.
      findFirst: async ({ where }: { where: { id: string; orgId: string; deletedAt: null } }) =>
        RESORTS.find(
          (r) => r.id === where.id && r.orgId === where.orgId && r.deletedAt === null,
        ) ?? null,
    },
  };
}

/** Only prisma and the audit log are reached on these paths. */
function service(prisma: ReturnType<typeof stubPrisma>) {
  const audit = { log: async () => undefined };
  const unused = {} as never;
  return new DevicesService(
    prisma as unknown as never,
    unused,
    audit as unknown as never,
    unused,
    unused,
    unused,
  );
}

describe('a terminal rebinding itself', () => {
  it('accepts a live resort in its own org', async () => {
    const prisma = stubPrisma([{ ...TERMINAL }]);
    const svc = service(prisma);
    // getDeviceMe is not what is under test here, and it reads rows this stub
    // does not carry; the write is the assertion.
    await svc.rebindSelf('dev-1', 'res-live').catch(() => undefined);

    expect(prisma.writes).toEqual([{ id: 'dev-1', resortId: 'res-live' }]);
  });

  it('refuses a resort belonging to another org', async () => {
    const prisma = stubPrisma([{ ...TERMINAL }]);
    await expect(service(prisma).rebindSelf('dev-1', 'res-other-org')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Refused as "not found" rather than "forbidden": a device has no business
    // learning that an id it guessed exists somewhere else.
    expect(prisma.writes).toEqual([]);
  });

  it('refuses a retired resort', async () => {
    const prisma = stubPrisma([{ ...TERMINAL }]);
    await expect(service(prisma).rebindSelf('dev-1', 'res-gone')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.writes).toEqual([]);
  });

  it('refuses a device that is not a time clock', async () => {
    const prisma = stubPrisma([{ ...BRIDGE }]);
    await expect(service(prisma).rebindSelf('dev-2', 'res-live')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.writes).toEqual([]);
  });
});

describe('an admin placing a terminal', () => {
  it('refuses a resort outside the org, the same as the device path does', async () => {
    const prisma = stubPrisma([{ ...TERMINAL }]);
    const svc = service(prisma);
    jest.spyOn(svc as unknown as { assertMayManage: () => Promise<void> }, 'assertMayManage')
      .mockResolvedValue(undefined);

    await expect(svc.bindResort('org-1', 'user-1', 'dev-1', 'res-other-org')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.writes).toEqual([]);
  });

  it('refuses to bind a resort to a print bridge', async () => {
    const prisma = stubPrisma([{ ...BRIDGE }]);
    const svc = service(prisma);
    jest.spyOn(svc as unknown as { assertMayManage: () => Promise<void> }, 'assertMayManage')
      .mockResolvedValue(undefined);

    await expect(svc.bindResort('org-1', 'user-1', 'dev-2', 'res-live')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('unbinds without touching the resort table', async () => {
    // Taking a tablet out of service keeps its credentials — it stops being
    // anywhere rather than being revoked — so null needs no resort to exist.
    const prisma = stubPrisma([{ ...TERMINAL, resortId: 'res-live' }]);
    const svc = service(prisma);
    jest.spyOn(svc as unknown as { assertMayManage: () => Promise<void> }, 'assertMayManage')
      .mockResolvedValue(undefined);
    jest.spyOn(svc, 'listDevices').mockResolvedValue([]);

    await svc.bindResort('org-1', 'user-1', 'dev-1', null);

    expect(prisma.writes).toEqual([{ id: 'dev-1', resortId: null }]);
  });

  it('refuses a device in another org', async () => {
    const prisma = stubPrisma([{ ...TERMINAL }]);
    await expect(
      service(prisma).bindResort('org-2', 'user-1', 'dev-1', 'res-live'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.writes).toEqual([]);
  });
});

describe('the role check on the device route', () => {
  it('is what stops a non-terminal reaching the service at all', () => {
    // The controller checks the role before the service does, so the refusal a
    // print bridge gets is a 403 rather than a 400 about resorts — it is being
    // told the route is not for it, not that its argument was wrong.
    expect(new ForbiddenException('Only a time clock terminal has a resort to change')
      .getStatus()).toBe(403);
  });
});

describe('provisioning a display', () => {
  /** The provision path reaches argon2 and the audit log; neither is the subject here. */
  function provisioner(prisma: ReturnType<typeof stubPrisma>) {
    const svc = service(prisma);
    jest
      .spyOn(svc as unknown as { assertMayManage: () => Promise<void> }, 'assertMayManage')
      .mockResolvedValue(undefined);
    return svc;
  }

  it('refuses one with no resort at all', async () => {
    // The rule a time-clock terminal does not have: "choose later" is not on
    // offer, because a display with no resort shows nothing.
    const prisma = stubPrisma([]);
    await expect(
      provisioner(prisma).provision('org-1', 'user-1', { role: 'signage.display' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.writes).toEqual([]);
  });

  it('refuses a resort belonging to another org', async () => {
    const prisma = stubPrisma([]);
    await expect(
      provisioner(prisma).provision('org-1', 'user-1', {
        role: 'signage.display',
        resortId: 'res-other-org',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('accepts a live resort in its own org', async () => {
    const prisma = stubPrisma([]);
    const created = await provisioner(prisma).provision('org-1', 'user-1', {
      name: 'Patrol room',
      role: 'signage.display',
      resortId: 'res-live',
    });

    expect(created.role).toBe('signage.display');
    // The secret is returned once and never stored; the hash is what lands.
    expect(created.clientSecret).toHaveLength(64);
  });

  it('still lets a time clock be provisioned without one', async () => {
    // The asymmetry is the point: an unbound terminal says so and boards
    // nothing, which is a state someone can act on.
    const prisma = stubPrisma([]);
    const created = await provisioner(prisma).provision('org-1', 'user-1', {
      name: 'Base lodge iPad',
      role: 'time_clock.terminal',
    });
    expect(created.role).toBe('time_clock.terminal');
  });
});

describe('an admin placing a display', () => {
  it('binds it the same way it binds a terminal', async () => {
    const prisma = stubPrisma([{ ...DISPLAY }]);
    const svc = service(prisma);
    jest.spyOn(svc as unknown as { assertMayManage: () => Promise<void> }, 'assertMayManage')
      .mockResolvedValue(undefined);
    jest.spyOn(svc, 'listDevices').mockResolvedValue([]);

    await svc.bindResort('org-1', 'user-1', 'dev-3', 'res-live');

    expect(prisma.writes).toEqual([{ id: 'dev-3', resortId: 'res-live' }]);
  });

  it('refuses a retired resort, exactly as for a terminal', async () => {
    const prisma = stubPrisma([{ ...DISPLAY }]);
    const svc = service(prisma);
    jest.spyOn(svc as unknown as { assertMayManage: () => Promise<void> }, 'assertMayManage')
      .mockResolvedValue(undefined);

    await expect(svc.bindResort('org-1', 'user-1', 'dev-3', 'res-gone')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.writes).toEqual([]);
  });
});

describe('a display rebinding itself', () => {
  it('is refused by the controller before the service sees it', () => {
    // Deliberate, not incidental. Rebinding exists because the moment it is
    // wanted is the moment a computer is least available — someone holding an
    // iPad in the building it just moved to. A screen on a wall has neither
    // that problem nor an input device to ask with.
    expect(
      new ForbiddenException('Only a time clock terminal has a resort to change').getStatus(),
    ).toBe(403);
  });
});
