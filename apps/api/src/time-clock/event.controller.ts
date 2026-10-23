import { Body, Controller, ForbiddenException, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { RequireModule } from '../common/decorators/require-module.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { TimeClockEventService } from './event.service';
import { SubmitEventsDto } from '../contracts/time-clock.contracts';
import { TIME_CLOCK_TABLET_ROLES } from '../contracts/devices.contracts';

/**
 * Devices only: clock events are recorded by the iPad that was there (§5.6), and speak
 * for that iPad alone (Plan 55 D3). A time-clock iPad, that is: a terminal or a tablet.
 *
 * `OrDeviceAuthGuard` rather than `DeviceAuthGuard` because only the former checks the
 * token's org against the URL's; the device requirement is enforced here instead.
 */
@Controller('orgs/:orgId/time-clock/events')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard)
@RequireModule('time_tracking')
export class TimeClockEventController {
  constructor(private readonly eventService: TimeClockEventService) {}

  @Post()
  @HttpCode(200)
  submit(
    @Param('orgId') orgId: string,
    @Body() body: SubmitEventsDto,
    @Req() req: Request & { device?: AuthenticatedDevice },
  ) {
    if (!req.device) throw new ForbiddenException('Clock events may only be submitted by a device');
    // Only an iPad clocks anyone in: a print bridge or a display may not (Plan 56).
    if (!(TIME_CLOCK_TABLET_ROLES as readonly string[]).includes(req.device.role)) {
      throw new ForbiddenException(`Requires a device of role: ${TIME_CLOCK_TABLET_ROLES.join(' or ')}`);
    }
    return this.eventService.submit(orgId, req.device.deviceId, body.events);
  }
}
