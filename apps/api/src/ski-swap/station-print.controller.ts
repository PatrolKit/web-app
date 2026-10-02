import { Body, Controller, ForbiddenException, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { DeviceAuthGuard } from '../common/guards/device-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { CurrentDevice } from '../common/decorators/current-device.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { PrintQueueService } from './print-queue.service';
import { StationPrintRequestDto } from '../contracts/ski-swap.contracts';

/**
 * Labels a station's iPad drew, printed through the station's bridge as sent
 * (iOS Plan 26): item tags, receipts, QR labels and helper labels.
 *
 * `202` once the pages are queued at a bridge that is online with a printer
 * that is ready; `409` with a code and a sentence that follows "didn't print:";
 * `400` for a request that can't be right. Nothing waits for later: what the
 * bridge hasn't taken within a minute is dropped.
 *
 * Its request body is allowed up to 3 MB (see `main.ts`): a page is 37–57 KB
 * packed, and a long receipt is several.
 */
@Controller('orgs/:orgId/ski-swap/stations/:stationId/print')
@UseGuards(DeviceAuthGuard, PermissionsGuard)
@RequireDeviceRole('ski_swap.staff_check_in')
export class StationPrintController {
  constructor(private readonly queue: PrintQueueService) {}

  @Post()
  @HttpCode(202)
  print(
    @CurrentDevice() device: AuthenticatedDevice,
    @Param('orgId') orgId: string,
    @Param('stationId') stationId: string,
    @Body() body: StationPrintRequestDto,
  ) {
    if (device.orgId !== orgId) throw new ForbiddenException('That is not this device’s organization');
    return this.queue.printDrawn(device.deviceId, orgId, stationId, body);
  }
}
