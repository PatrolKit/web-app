import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../../common/guards/super-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/guards/jwt-auth.guard';
import { IndemnificationImportService } from './indemnification-import.service';
import { PatchIndemnificationProgramDto } from '../../contracts/indemnification.contracts';

/**
 * The registry's maintenance (Plan 44 D3, D8): super admins only, as the
 * shared tree's editor is. What every patrol reads is not one patrol's to
 * change.
 */
@Controller('admin/bindings/indemnification')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class IndemnificationAdminController {
  constructor(private readonly service: IndemnificationImportService) {}

  @Get('programs')
  programs() {
    return this.service.programs();
  }

  @Patch('programs/:key')
  patchProgram(
    @Param('key') key: string,
    @Body() body: PatchIndemnificationProgramDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.patchProgram(key, body, user.userId);
  }

  /**
   * The seasonal CSV. `dryRun=true` answers what it would do and writes
   * nothing; without it, the file is committed in one transaction.
   */
  @Post('import')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('season') season: string | undefined,
    @Body('dryRun') dryRun: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    if (!file) throw new BadRequestException('Attach the CSV as "file"');
    if (!season) throw new BadRequestException('season is required, like 2025-26');
    if (dryRun === 'true' || dryRun === '1') return this.service.dryRun(file.buffer, season);
    return this.service.commit(file.buffer, season, user.userId, file.originalname ?? null, req.ip);
  }

  @Get('imports')
  imports() {
    return this.service.imports();
  }

  /** Which patrols have declared NSSRA membership (D5). */
  @Get('orgs')
  orgs() {
    return this.service.declarations();
  }
}
