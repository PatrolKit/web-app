import { Body, Controller, ForbiddenException, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { RequireModule } from '../common/decorators/require-module.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { TimeClockEventService } from './event.service';
import { SubmitEventsDto } from '../contracts/time-clock.contracts';

/**
 * Devices only: clock events are recorded by the iPad that was there (§5.6).
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
    return this.eventService.submit(orgId, req.device.deviceId, body.events);
  }
}
