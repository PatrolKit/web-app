import { SetMetadata } from '@nestjs/common';
import type { DeviceRole } from '../../contracts/devices.contracts';

export const DEVICE_ROLES_KEY = 'deviceRoles';

/**
 * Restricts a route to devices of the given roles.
 *
 * Devices are authorised by what kind of device they are, not by a per-device
 * permission set — a check-in iPad is a check-in iPad, and there is no coherent
 * "check-in iPad that also does time clock". A route with no `@RequireDeviceRole`
 * refuses device tokens outright, so reachability is opt-in rather than assumed.
 */
export const RequireDeviceRole = (...roles: DeviceRole[]) => SetMetadata(DEVICE_ROLES_KEY, roles);

/**
 * Closes one route to devices on a controller whose class opens them all.
 *
 * `@RequireDeviceRole` resolves with `getAllAndOverride([handler, class])`, so
 * a class-level role reaches every method that does not override it. Overriding
 * with an empty `@RequireDeviceRole()` would do the job and read as the exact
 * opposite of its effect, which is how the next person gets it wrong.
 *
 * `PermissionsGuard` refuses a device token wherever no role is named, so this
 * is the same mechanism said plainly rather than a second one.
 */
export const NoDeviceAccess = () => SetMetadata(DEVICE_ROLES_KEY, []);
