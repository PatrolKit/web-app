import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DevicePinSchema, UpdateDevicePinSchema } from '../contracts/devices.contracts';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { SkiSwapSettingsService } from '../ski-swap/ski-swap-settings.service';
import { SkiSwapSettingsController } from '../ski-swap/ski-swap-settings.controller';
import { TimeClockSettingsService } from '../time-clock/time-clock-settings.service';
import { TimeClockSettingsController } from '../time-clock/time-clock-settings.controller';

/**
 * The PIN that unlocks a device's settings screen.
 *
 * Three things are worth pinning down. The shape, because four digits is a
 * contract two keypads are built against. The null case, because null means the
 * gate is *open* and a bug that produced one silently would open every settings
 * sheet in the fleet. And who may read it, because it is stored in the clear and
 * the whole reason it sits on a route of its own is that the settings response
 * beside it has a wider audience.
 */

// ─── Shape ────────────────────────────────────────────────────────────────────

describe('the PIN itself', () => {
  it.each(['0000', '1938', '9999'])('accepts %s', (pin) => {
    expect(DevicePinSchema.safeParse(pin).success).toBe(true);
  });

  it.each(['123', '12345', '12a4', '', ' 123', '12 4'])('rejects %s', (pin) => {
    expect(DevicePinSchema.safeParse(pin).success).toBe(false);
  });

  it('takes null as an instruction to remove the gate', () => {
    expect(UpdateDevicePinSchema.safeParse({ devicePin: null }).success).toBe(true);
  });

  it('refuses a body that omits the field', () => {
    // Removing the PIN has to be something a caller means. If omission were
    // allowed it would be indistinguishable from a client that forgot to send.
    expect(UpdateDevicePinSchema.safeParse({}).success).toBe(false);
  });

  it('refuses an unknown field', () => {
    expect(UpdateDevicePinSchema.safeParse({ devicePin: '1234', pin: '1234' }).success).toBe(false);
  });
});

// ─── Reading and writing ──────────────────────────────────────────────────────

/**
 * Enough Prisma for a settings row and the audit entry the write leaves.
 *
 * The rest of the row travels along because `TimeClockSettingsService.get` is
 * on the write path — it is what creates the row before the update lands — and
 * it renders the whole response.
 */
function stubPrisma(pin: string | null, exists = true) {
  const rest = {
    orgId: 'org-1',
    autoCloseLocalTime: '03:00',
    autoCloseAfterHours: 4,
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
  let current: (typeof rest & { devicePin: string | null }) | null = exists
    ? { ...rest, devicePin: pin }
    : null;
  const audits: string[] = [];
  return {
    audits,
    skiSwapSettings: {
      findUnique: async () => current,
      upsert: async ({ update }: { update: { devicePin: string | null } }) => {
        current = { ...rest, ...(current ?? {}), devicePin: update.devicePin };
        return current;
      },
    },
    timeClockSettings: {
      findUnique: async () => current,
      create: async () => {
        current = { ...rest, devicePin: null };
        return current;
      },
      update: async ({ data }: { data: { devicePin: string | null } }) => {
        current = { ...rest, ...(current ?? {}), devicePin: data.devicePin };
        return current;
      },
    },
    auditLog: {
      create: async ({ data }: { data: { action: string; metadata?: unknown } }) => {
        // The value is deliberately not recorded: the log must not become a way
        // around the permission on the endpoint that returns it.
        expect(JSON.stringify(data)).not.toContain('4021');
        audits.push(data.action);
        return data;
      },
    },
  };
}

describe.each([
  ['ski swap', (p: unknown) => new SkiSwapSettingsService(p as never), 'ski_swap'],
  ['time clock', (p: unknown) => new TimeClockSettingsService(p as never), 'time_clock'],
])('%s settings', (_name, make, prefix) => {
  it('reports null for an org that has never set one', async () => {
    const svc = make(stubPrisma(null, false));
    await expect(svc.getDevicePin('org-1')).resolves.toEqual({ devicePin: null });
  });

  it('round-trips a PIN', async () => {
    const prisma = stubPrisma(null);
    const svc = make(prisma);
    await svc.setDevicePin('org-1', '4021', 'user-1');
    await expect(svc.getDevicePin('org-1')).resolves.toEqual({ devicePin: '4021' });
  });

  it('clears one', async () => {
    const prisma = stubPrisma('4021');
    const svc = make(prisma);
    await svc.setDevicePin('org-1', null, 'user-1');
    await expect(svc.getDevicePin('org-1')).resolves.toEqual({ devicePin: null });
  });

  it('audits setting and clearing as different actions', async () => {
    const prisma = stubPrisma(null);
    const svc = make(prisma);
    await svc.setDevicePin('org-1', '4021', 'user-1');
    await svc.setDevicePin('org-1', null, 'user-1');
    expect(prisma.audits).toEqual([
      `${prefix}.device_pin.updated`,
      `${prefix}.device_pin.cleared`,
    ]);
  });
});

// ─── Who may reach it ─────────────────────────────────────────────────────────

/**
 * `@RequireDeviceRole` moved from these controllers' classes onto the methods
 * that want it, which is what makes the write routes refuse a device without a
 * line of code saying so. The guard resolves it with `getAllAndOverride`, so
 * this exercises the real metadata on the real controllers rather than trusting
 * that it does.
 */
function guardFor(
  controller: object,
  method: string,
  principal: { device?: { role: string } ; user?: { userId: string } },
  granted: string[] = [],
) {
  const guard = new PermissionsGuard(new Reflector(), {
    getPermissions: async () => granted,
  } as never);
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({ ...principal, params: { orgId: 'org-1' } }),
    }),
    getHandler: () => (controller as Record<string, unknown>)[method],
    getClass: () => controller.constructor,
  };
  return () => guard.canActivate(ctx as never);
}

describe('the ski-swap PIN route', () => {
  const controller = SkiSwapSettingsController.prototype;

  it('admits the check-in iPad to the read', async () => {
    await expect(
      guardFor(controller, 'getDevicePin', { device: { role: 'ski_swap.staff_check_in' } })(),
    ).resolves.toBe(true);
  });

  it('refuses the check-in iPad the write', async () => {
    // No `@RequireDeviceRole` on the method, so the guard's own "not available
    // to devices" branch catches it. Nothing here says `PUT` is people-only.
    await expect(
      guardFor(controller, 'setDevicePin', { device: { role: 'ski_swap.staff_check_in' } })(),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a time-clock terminal outright', async () => {
    await expect(
      guardFor(controller, 'getDevicePin', { device: { role: 'time_clock.terminal' } })(),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a reporter and admits an admin', async () => {
    await expect(
      guardFor(controller, 'getDevicePin', { user: { userId: 'u1' } }, ['ski_swap:report'])(),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guardFor(controller, 'getDevicePin', { user: { userId: 'u1' } }, ['ski_swap:admin'])(),
    ).resolves.toBe(true);
  });

  it('still admits the iPad to the settings route it already read', async () => {
    // The regression the move could have caused: `@RequireDeviceRole` came off
    // the class, and `GET /settings` has to keep its own.
    await expect(
      guardFor(controller, 'get', { device: { role: 'ski_swap.staff_check_in' } })(),
    ).resolves.toBe(true);
  });

  it('refuses the iPad the settings write', async () => {
    await expect(
      guardFor(controller, 'update', { device: { role: 'ski_swap.staff_check_in' } })(),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('the time-clock PIN route', () => {
  const controller = TimeClockSettingsController.prototype;

  it('admits the terminal to the read', async () => {
    await expect(
      guardFor(controller, 'getDevicePin', { device: { role: 'time_clock.terminal' } })(),
    ).resolves.toBe(true);
  });

  it('refuses the terminal the write', async () => {
    await expect(
      guardFor(controller, 'setDevicePin', { device: { role: 'time_clock.terminal' } })(),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a check-in iPad outright', async () => {
    await expect(
      guardFor(controller, 'getDevicePin', { device: { role: 'ski_swap.staff_check_in' } })(),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a reporter and admits an admin', async () => {
    await expect(
      guardFor(controller, 'getDevicePin', { user: { userId: 'u1' } }, ['time_tracking:report'])(),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guardFor(controller, 'getDevicePin', { user: { userId: 'u1' } }, ['time_tracking:admin'])(),
    ).resolves.toBe(true);
  });

  it('still admits the terminal to the settings route it already read', async () => {
    await expect(
      guardFor(controller, 'get', { device: { role: 'time_clock.terminal' } })(),
    ).resolves.toBe(true);
  });
});
