import { Body, Controller, ForbiddenException, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { DeviceAuthGuard } from '../common/guards/device-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { CurrentDevice } from '../common/decorators/current-device.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { PrintQueueService } from './print-queue.service';
import { HelperLabelsRequestDto } from '../contracts/ski-swap.contracts';

/**
 * Legacy helper labels, printed now through the station's bridge (Plan 28), for
 * a staff iPad with no 25 × 67 printer of its own.
 *
 * Answers `202` once the pair is queued at a bridge that is online with a
 * printer that is online, or `409` with a code and a sentence the iPad shows
 * after "helper labels didn't print:". Nothing is queued for later: a refused
 * or failed call means these labels do not print.
 */
@Controller('orgs/:orgId/ski-swap/stations/:stationId/helper-labels')
@UseGuards(DeviceAuthGuard, PermissionsGuard)
@RequireDeviceRole('ski_swap.staff_check_in')
export class HelperLabelController {
  constructor(private readonly queue: PrintQueueService) {}

  @Post()
  @HttpCode(202)
  print(
    @CurrentDevice() device: AuthenticatedDevice,
    @Param('orgId') orgId: string,
    @Param('stationId') stationId: string,
    @Body() body: HelperLabelsRequestDto,
  ) {
    if (device.orgId !== orgId) throw new ForbiddenException('That is not this device’s organization');
    return this.queue.printHelperLabels(device.deviceId, orgId, stationId, {
      ...body,
      itemId: body.itemId ?? null,
    });
  }
}
