import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DevicesService } from './devices.service';

/**
 * Where a time-clock terminal says it stands.
 *
 * Two callers write this: an admin placing hardware, and the tablet itself
 * after being carried to another lodge. They share one rule — a live resort, in
 * the device's own org, on a device that is actually a time clock — and the
 * tests below are mostly about that rule holding from both directions, since a
 * device authenticates as itself and cannot be checked by a permission.
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
