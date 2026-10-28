import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { ItemController } from '../ski-swap/item.controller';
import { TimeEntryController } from '../time-clock/time-entry.controller';
import { TimeClockEventController } from '../time-clock/event.controller';
import { StationService } from '../ski-swap/station.service';
import { DevicesService } from './devices.service';
import { DevicesMeController } from './devices-me.controller';

/**
 * Plan 56: one iPad, either module. A tablet is let into both modules' iPad
 * routes, belongs to the org's administrators, reports its mode, and is chosen
 * for a station on Check-in.
 */

function guardFor(controller: object, method: string, principal: { device?: { role: string }; user?: { userId: string } }) {
  const guard = new PermissionsGuard(new Reflector(), { getPermissions: async () => [] } as never);
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ ...principal, params: { orgId: 'org-1' } }) }),
    getHandler: () => (controller as Record<string, unknown>)[method],
    getClass: () => controller.constructor,
  };
  return () => guard.canActivate(ctx as never);
}

describe('a tablet’s token', () => {
  it('reaches Ski Swap’s and Time Clock’s iPad routes', async () => {
    await expect(guardFor(ItemController.prototype, 'list', { device: { role: 'org.tablet' } })()).resolves.toBe(true);
    await expect(guardFor(TimeEntryController.prototype, 'list', { device: { role: 'org.tablet' } })()).resolves.toBe(true);
  });

  it('leaves the legacy iPads where they were', async () => {
    await expect(guardFor(ItemController.prototype, 'list', { device: { role: 'ski_swap.staff_check_in' } })()).resolves.toBe(true);
    await expect(guardFor(TimeEntryController.prototype, 'list', { device: { role: 'ski_swap.staff_check_in' } })()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guardFor(ItemController.prototype, 'list', { device: { role: 'time_clock.terminal' } })()).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('clock events', () => {
  const submit = (role: string) => {
    const controller = new TimeClockEventController({ submit: async () => ({ results: [] }) } as never);
    return (async () => controller.submit('org-1', { events: [] } as never, { device: { deviceId: 'd1', orgId: 'org-1', role } } as never))();
  };

  it('come from a terminal or a tablet', async () => {
    await expect(submit('time_clock.terminal')).resolves.toBeDefined();
    await expect(submit('org.tablet')).resolves.toBeDefined();
  });

  it('never from a print bridge, a display or a check-in iPad', async () => {
    for (const role of ['ski_swap.print_bridge', 'signage.display', 'ski_swap.staff_check_in']) {
      await expect(submit(role)).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
});

describe('who manages a tablet', () => {
  function service(granted: string[], devices: { id: string; role: string }[] = []) {
    const prisma = { device: { findUnique: async ({ where }: { where: { id: string } }) => ({ ...devices.find((d) => d.id === where.id), orgId: 'org-1' }) } };
    return new DevicesService(
      prisma as never, {} as never, {} as never,
      { getPermissions: async () => granted } as never,
      { isEnabled: async () => true } as never,
      {} as never,
    );
  }

  it('is an org administrator, whichever modules they run', async () => {
    await expect(service(['org:manage']).assertMayManage('org-1', 'u1', 'org.tablet')).resolves.toBeUndefined();
  });

  it('is not a Ski Swap or Time Tracking admin', async () => {
    await expect(service(['ski_swap:admin', 'time_tracking:manage']).assertMayManage('org-1', 'u1', 'org.tablet')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('includes an iPad still on a module’s role', async () => {
    await expect(service(['org:manage']).assertMayManage('org-1', 'u1', 'ski_swap.staff_check_in')).resolves.toBeUndefined();
    await expect(service(['org:manage']).assertMayManage('org-1', 'u1', 'time_clock.terminal')).resolves.toBeUndefined();
  });

  it('gives an org admin nothing else', async () => {
    await expect(service(['org:manage']).assertMayManage('org-1', 'u1', 'ski_swap.print_bridge')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('the mode a tablet reports', () => {
  function me() {
    const calls: unknown[] = [];
    const controller = new DevicesMeController({ getDeviceMe: async (_id: string, app: unknown) => { calls.push(app); return {}; } } as never, {} as never);
    const device = { deviceId: 'd1', orgId: 'org-1', role: 'org.tablet' };
    return { calls, ask: (mode?: string) => controller.getMe(device as never, '1.0', '42', undefined, mode) };
  }

  it('is passed on when it is a mode', async () => {
    const { calls, ask } = me();
    await ask('time_clock');
    await ask('ski_swap/end_of_swap_pickup');
    expect(calls.map((c) => (c as { mode?: string }).mode)).toEqual(['time_clock', 'ski_swap/end_of_swap_pickup']);
  });

  it('is ignored when it is anything else, so the last report stands', async () => {
    const { calls, ask } = me();
    for (const junk of [undefined, '', 'Time Clock', 'ski_swap/check_in/extra', 'x'.repeat(70), '<script>']) await ask(junk);
    expect(calls.every((c) => (c as { mode?: string }).mode === undefined)).toBe(true);
  });
});

describe('a station’s tablet', () => {
  type Row = { id: string; name: string; orgId: string; staffed: boolean; attendantDeviceId: string | null; bridgeDeviceId: string | null; deletedAt: Date | null };

  function stations(rows: Row[], devices: { id: string; name: string; role: string }[]) {
    const prisma = {
      checkinStation: {
        findFirst: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id && !r.deletedAt) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return { ...row, code: 'A', createdAt: new Date(), attendant: null, bridge: null };
        },
      },
      device: {
        findFirst: async ({ where }: { where: { id: string } }) => {
          const d = devices.find((x) => x.id === where.id);
          if (!d) return null;
          const held = rows.find((r) => r.attendantDeviceId === d.id) ?? null;
          return { ...d, orgId: 'org-1', attendedStation: held };
        },
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    };
    return new StationService(prisma as never, {} as never);
  }
  const station = (id: string, name: string, attendantDeviceId: string | null, staffed = true): Row =>
    ({ id, name, orgId: 'org-1', staffed, attendantDeviceId, bridgeDeviceId: null, deletedAt: null });

  it('can be any iPad, a tablet or a legacy one, but not a bridge', async () => {
    const rows = [station('s1', 'Station 1', null)];
    const svc = stations(rows, [{ id: 't1', name: 'iPad 1', role: 'org.tablet' }, { id: 'b1', name: 'Bridge', role: 'ski_swap.print_bridge' }]);
    await svc.update('org-1', 's1', { attendantDeviceId: 't1' });
    expect(rows[0].attendantDeviceId).toBe('t1');
    await expect(svc.update('org-1', 's1', { attendantDeviceId: 'b1' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('in use elsewhere is refused, naming that station', async () => {
    const rows = [station('s1', 'Station 1', 't1'), station('s2', 'Station 2', null)];
    const svc = stations(rows, [{ id: 't1', name: 'iPad 1', role: 'org.tablet' }]);
    const err = await svc.update('org-1', 's2', { attendantDeviceId: 't1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'TABLET_IN_USE', stationName: 'Station 1' });
    expect(rows.map((r) => r.attendantDeviceId)).toEqual(['t1', null]);
  });

  it('moves when asked, leaving the other station staffed and waiting', async () => {
    const rows = [station('s1', 'Station 1', 't1'), station('s2', 'Station 2', null)];
    const svc = stations(rows, [{ id: 't1', name: 'iPad 1', role: 'org.tablet' }]);
    await svc.update('org-1', 's2', { attendantDeviceId: 't1', takeTablet: true });
    expect(rows.map((r) => [r.attendantDeviceId, r.staffed])).toEqual([[null, true], ['t1', true]]);
  });

  it('goes when the station becomes self-service', async () => {
    const rows = [station('s1', 'Station 1', 't1')];
    const svc = stations(rows, [{ id: 't1', name: 'iPad 1', role: 'org.tablet' }]);
    await svc.update('org-1', 's1', { kind: 'self_service' });
    expect([rows[0].staffed, rows[0].attendantDeviceId]).toEqual([false, null]);
  });

  it('released leaves the station staffed', async () => {
    const rows = [station('s1', 'Station 1', 't1')];
    const svc = stations(rows, [{ id: 't1', name: 'iPad 1', role: 'org.tablet' }]);
    await svc.update('org-1', 's1', { attendantDeviceId: null });
    expect([rows[0].staffed, rows[0].attendantDeviceId]).toEqual([true, null]);
  });
});
