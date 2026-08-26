import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { StationService } from './station.service';
import { PrintQueueService } from './print-queue.service';
import { CreateStationDto, UpdateStationDto } from '../contracts/ski-swap.contracts';

@Controller('orgs/:orgId/ski-swap/stations')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class StationController {
  constructor(
    private readonly stations: StationService,
    private readonly queue: PrintQueueService,
  ) {}

  @Get()
  @RequirePermissions('ski_swap:report')
  list(@Param('orgId') orgId: string) {
    return this.stations.list(orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('ski_swap:admin')
  create(@Param('orgId') orgId: string, @Body() body: CreateStationDto) {
    return this.stations.create(orgId, body.name);
  }

  @Patch(':stationId')
  @RequirePermissions('ski_swap:admin')
  update(
    @Param('orgId') orgId: string,
    @Param('stationId') stationId: string,
    @Body() body: UpdateStationDto,
  ) {
    return this.stations.update(orgId, stationId, body);
  }

  @Delete(':stationId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:admin')
  async remove(@Param('orgId') orgId: string, @Param('stationId') stationId: string) {
    await this.stations.remove(orgId, stationId);
  }

  // ─── Queue ────────────────────────────────────────────────────────────────

  /** Staff need to see a stuck station without reading logs. */
  @Get(':stationId/queue')
  @RequirePermissions('ski_swap:report')
  queueDepth(@Param('orgId') orgId: string, @Param('stationId') stationId: string) {
    return this.queue.stationQueue(orgId, stationId);
  }

  /** Exercises the whole chain: server, bridge, BLE link, printer. */
  @Post(':stationId/test')
  @HttpCode(202)
  @RequirePermissions('ski_swap:manage')
  async test(@Param('orgId') orgId: string, @Param('stationId') stationId: string) {
    await this.queue.enqueueCalibration(orgId, stationId);
    return { queued: true };
  }

  @Delete(':stationId/queue')
  @RequirePermissions('ski_swap:manage')
  async clear(@Param('orgId') orgId: string, @Param('stationId') stationId: string) {
    return { cleared: await this.queue.clearQueue(orgId, stationId) };
  }
}
