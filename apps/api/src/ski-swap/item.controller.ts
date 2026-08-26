import {
  Body, Controller, Delete, Get, Headers, HttpCode, Param,
  Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { ItemService } from './item.service';
import { CreateItemDto, PatchItemDto } from '../contracts/ski-swap.contracts';

@Controller('orgs/:orgId/ski-swap/swaps/:swapId/items')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireDeviceRole('Ski Swap - Check-In', 'Ski Swap - Bulk Seller')
@RequireModule('ski_swap')
export class ItemController {
  constructor(private readonly itemService: ItemService) {}

  @Get()
  @RequirePermissions('ski_swap:report')
  list(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Query('query') query?: string,
    @Query('sellerId') sellerId?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('updatedSince') updatedSince?: string,
  ) {
    return this.itemService.list(orgId, swapId, {
      query,
      sellerId,
      skip: skip ? parseInt(skip, 10) : undefined,
      take: take ? parseInt(take, 10) : undefined,
      updatedSince,
    });
  }

  @Post()
  @RequirePermissions('ski_swap:manage')
  create(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Body() body: CreateItemDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.itemService.create(orgId, swapId, body, idempotencyKey);
  }

  @Get(':itemId')
  @RequirePermissions('ski_swap:report')
  get(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('itemId') itemId: string) {
    return this.itemService.get(orgId, swapId, itemId);
  }

  @Patch(':itemId')
  @RequirePermissions('ski_swap:manage')
  patch(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('itemId') itemId: string, @Body() body: PatchItemDto) {
    return this.itemService.patch(orgId, swapId, itemId, body);
  }

  @Delete(':itemId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:manage')
  async remove(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('itemId') itemId: string) {
    await this.itemService.remove(orgId, swapId, itemId);
  }

  @Post(':itemId/photos')
  @RequirePermissions('ski_swap:manage')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadPhoto(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('itemId') itemId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.itemService.uploadPhoto(orgId, swapId, itemId, file);
  }

  @Delete(':itemId/photos/:photoId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:manage')
  async deletePhoto(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('itemId') itemId: string,
    @Param('photoId') photoId: string,
  ) {
    await this.itemService.deletePhoto(orgId, swapId, itemId, photoId);
  }
}
