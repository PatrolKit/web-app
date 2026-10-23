import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { PatrollerService } from './patroller.service';
import {
  CreatePatrollerDto,
  ImportPatrollersDto,
  PatchPatrollerDto,
  PatrollerListQueryDto,
} from '../contracts/time-clock.contracts';
import { TIME_CLOCK_TABLET_ROLES } from '../contracts/devices.contracts';

@Controller('orgs/:orgId/time-clock/patrollers')
/**
 * `@RequireDeviceRole` on the roster read only: a class-wide role let a terminal edit
 * the roster, because `PermissionsGuard` passes a device on its role alone.
 */
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('time_tracking')
export class PatrollerController {
  constructor(private readonly patrollerService: PatrollerService) {}

  @Get()
  @RequireDeviceRole(...TIME_CLOCK_TABLET_ROLES)
  @RequirePermissions('time_tracking:report')
  list(
    @Param('orgId') orgId: string,
    @Query() query: PatrollerListQueryDto,
    @Req() req: Request & { device?: AuthenticatedDevice },
  ) {
    return this.patrollerService.list(orgId, query, { forDevice: !!req.device });
  }

  @Post()
  @RequirePermissions('time_tracking:manage')
  create(@Param('orgId') orgId: string, @Body() body: CreatePatrollerDto, @CurrentUser() user: AuthenticatedUser) {
    return this.patrollerService.create(orgId, body, user.userId);
  }

  @Get('import/template')
  @RequirePermissions('time_tracking:manage')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="roster-template.csv"')
  downloadTemplate(@Res() res: Response) {
    res.send('firstName,lastName,nspId,patrolLevel\n');
  }

  @Post('import/parse')
  @HttpCode(200)
  @RequirePermissions('time_tracking:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  parseImport(@UploadedFile() file: Express.Multer.File) {
    const { headers, rows, mapping } = this.patrollerService.parseImportFile(file.buffer);
    return { headers, mapping, preview: rows.slice(0, 5), totalRows: rows.length };
  }

  @Post('import')
  @HttpCode(200)
  @RequirePermissions('time_tracking:manage')
  import(@Param('orgId') orgId: string, @Body() body: ImportPatrollersDto, @CurrentUser() user: AuthenticatedUser) {
    return this.patrollerService.importRows(orgId, body.rows, body.strategy, user.userId);
  }

  @Patch(':patrollerId')
  @RequirePermissions('time_tracking:manage')
  patch(
    @Param('orgId') orgId: string,
    @Param('patrollerId') patrollerId: string,
    @Body() body: PatchPatrollerDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.patrollerService.patch(orgId, patrollerId, body, user.userId);
  }

  @Delete(':patrollerId')
  @HttpCode(200)
  @RequirePermissions('time_tracking:manage')
  remove(
    @Param('orgId') orgId: string,
    @Param('patrollerId') patrollerId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.patrollerService.remove(orgId, patrollerId, user.userId);
  }
}
