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
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { SellerService } from './seller.service';
import { CreateSellerDto, PatchSellerDto } from '../contracts/ski-swap.contracts';

@Controller('orgs/:orgId/ski-swap/sellers')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class SellerController {
  constructor(private readonly sellerService: SellerService) {}

  @Get()
  @RequirePermissions('ski_swap:report')
  list(@Param('orgId') orgId: string, @Query('query') query?: string) {
    return this.sellerService.list(orgId, query);
  }

  @Post()
  @RequirePermissions('ski_swap:manage')
  create(@Param('orgId') orgId: string, @Body() body: CreateSellerDto) {
    return this.sellerService.create(orgId, body);
  }

  @Get(':sellerId')
  @RequirePermissions('ski_swap:report')
  get(@Param('orgId') orgId: string, @Param('sellerId') sellerId: string) {
    return this.sellerService.get(orgId, sellerId);
  }

  @Patch(':sellerId')
  @RequirePermissions('ski_swap:manage')
  patch(
    @Param('orgId') orgId: string,
    @Param('sellerId') sellerId: string,
    @Body() body: PatchSellerDto,
  ) {
    return this.sellerService.patch(orgId, sellerId, body);
  }

  @Delete(':sellerId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:manage')
  async remove(@Param('orgId') orgId: string, @Param('sellerId') sellerId: string) {
    await this.sellerService.remove(orgId, sellerId);
  }

  @Get('import/template')
  @RequirePermissions('ski_swap:manage')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="sellers-template.csv"')
  downloadTemplate(@Res() res: Response) {
    res.send('name,phone,email,street,city,state,zip\n');
  }

  @Post('import/parse')
  @HttpCode(200)
  @RequirePermissions('ski_swap:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  parseImport(@UploadedFile() file: Express.Multer.File) {
    const { headers, rows, mapping } = this.sellerService.parseImportFile(file.buffer);
    const preview = rows.slice(0, 5);
    return { headers, mapping, preview, totalRows: rows.length };
  }

  @Post('import')
  @HttpCode(200)
  @RequirePermissions('ski_swap:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  importSellers(
    @Param('orgId') orgId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('mapping') mappingJson: string,
    @Body('duplicateStrategy') duplicateStrategy: 'overwrite' | 'preserve',
  ) {
    const mapping = JSON.parse(mappingJson) as Record<string, string>;
    return this.sellerService.importSellers(orgId, file.buffer, mapping, duplicateStrategy);
  }
}
