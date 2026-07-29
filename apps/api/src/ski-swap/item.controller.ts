import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { ItemService } from './item.service';
import { AssignSellerDto, CreateItemDto, PatchItemDto } from '../contracts/ski-swap.contracts';

@Controller('orgs/:orgId/ski-swap/swaps/:swapId/items')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class ItemController {
  constructor(private readonly itemService: ItemService) {}

  @Get()
  @RequirePermissions('ski_swap:report')
  list(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('query') query?: string,
  ) {
    return this.itemService.list(orgId, swapId, {
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      query,
    });
  }

  @Post()
  @RequirePermissions('ski_swap:manage')
  create(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Body() body: CreateItemDto,
  ) {
    return this.itemService.create(orgId, swapId, body);
  }

  @Get(':squareItemId')
  @RequirePermissions('ski_swap:report')
  get(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('squareItemId') squareItemId: string,
  ) {
    return this.itemService.get(orgId, swapId, squareItemId);
  }

  @Patch(':squareItemId')
  @RequirePermissions('ski_swap:manage')
  patch(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('squareItemId') squareItemId: string,
    @Body() body: PatchItemDto,
  ) {
    return this.itemService.patch(orgId, swapId, squareItemId, body);
  }

  @Delete(':squareItemId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:manage')
  async remove(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('squareItemId') squareItemId: string,
  ) {
    await this.itemService.remove(orgId, swapId, squareItemId);
  }

  // ─── Seller assignment ────────────────────────────────────────────────────

  @Put(':squareItemId/seller')
  @HttpCode(204)
  @RequirePermissions('ski_swap:manage')
  async assignSeller(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('squareItemId') squareItemId: string,
    @Body() body: AssignSellerDto,
  ) {
    await this.itemService.assignSeller(orgId, swapId, squareItemId, body.sellerId);
  }

  @Delete(':squareItemId/seller')
  @HttpCode(204)
  @RequirePermissions('ski_swap:manage')
  async unassignSeller(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('squareItemId') squareItemId: string,
  ) {
    await this.itemService.unassignSeller(orgId, swapId, squareItemId);
  }

  // ─── Photos ───────────────────────────────────────────────────────────────

  @Post(':squareItemId/images')
  @RequirePermissions('ski_swap:manage')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadImage(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('squareItemId') squareItemId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.itemService.uploadImage(orgId, swapId, squareItemId, file);
  }

  @Delete(':squareItemId/images/:imageId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:manage')
  async deleteImage(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('squareItemId') squareItemId: string,
    @Param('imageId') imageId: string,
  ) {
    await this.itemService.deleteImage(orgId, swapId, squareItemId, imageId);
  }
}
