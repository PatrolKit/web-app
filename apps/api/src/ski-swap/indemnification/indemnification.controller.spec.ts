import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { IndemnificationController } from './indemnification.controller';
import { PERMISSIONS_KEY } from '../../common/decorators/require-permissions.decorator';
import { DEVICE_ROLES_KEY } from '../../common/decorators/require-device-role.decorator';
import { OrDeviceAuthGuard } from '../../common/guards/or-device-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';

/**
 * Who may read the indemnified lists (Plan 44 D10): the patrol's staff and its
 * check-in iPads. Not sellers, who are members too and hold no ski-swap
 * permission; a business seller is a retail shop, exactly who NSSRA's
 * members-only list is kept from.
 */
describe('the bindings lookup routes', () => {
  const reflector = new Reflector();

  it('need a staff permission', () => {
    expect(reflector.get(PERMISSIONS_KEY, IndemnificationController)).toEqual(['ski_swap:report']);
  });

  it('admit a check-in iPad, and no other device', () => {
    expect(reflector.get(DEVICE_ROLES_KEY, IndemnificationController)).toEqual(['ski_swap.staff_check_in']);
  });

  it('check both, through the guards that read them', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, IndemnificationController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([OrDeviceAuthGuard, PermissionsGuard]));
  });

  it('override neither on any route', () => {
    for (const name of ['manufacturers', 'models', 'search', 'model'] as const) {
      const handler = IndemnificationController.prototype[name];
      expect(reflector.get(PERMISSIONS_KEY, handler)).toBeUndefined();
      expect(reflector.get(DEVICE_ROLES_KEY, handler)).toBeUndefined();
    }
  });
});
