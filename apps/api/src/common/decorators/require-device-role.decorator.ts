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
