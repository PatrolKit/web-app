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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { PatrollerService } from './patroller.service';
import {
  CreatePatrollerDto,
  ImportPatrollersDto,
  PatchPatrollerDto,
} from '../contracts/time-clock.contracts';

@Controller('orgs/:orgId/time-clock/patrollers')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireDeviceRole('time_clock.terminal')
@RequireModule('time_tracking')
export class PatrollerController {
  constructor(private readonly patrollerService: PatrollerService) {}

  @Get()
  @RequirePermissions('time_tracking:report')
  list(@Param('orgId') orgId: string, @Query('updatedSince') updatedSince?: string) {
    return this.patrollerService.list(orgId, updatedSince);
  }

  @Post()
  @RequirePermissions('time_tracking:manage')
  create(@Param('orgId') orgId: string, @Body() body: CreatePatrollerDto) {
    return this.patrollerService.create(orgId, body);
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
  import(@Param('orgId') orgId: string, @Body() body: ImportPatrollersDto) {
    return this.patrollerService.importRows(orgId, body.rows, body.strategy);
  }

  @Patch(':patrollerId')
  @RequirePermissions('time_tracking:manage')
  patch(
    @Param('orgId') orgId: string,
    @Param('patrollerId') patrollerId: string,
    @Body() body: PatchPatrollerDto,
  ) {
    return this.patrollerService.patch(orgId, patrollerId, body);
  }

  @Delete(':patrollerId')
  @HttpCode(200)
  @RequirePermissions('time_tracking:manage')
  remove(@Param('orgId') orgId: string, @Param('patrollerId') patrollerId: string) {
    return this.patrollerService.remove(orgId, patrollerId);
  }
}
