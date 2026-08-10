import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { SellerSelfService } from './seller-self.service';
import { PatchSellerDto, SellerItemCreateDto, SellerItemUpdateDto } from '../contracts/ski-swap.contracts';

@Controller('orgs/:orgId/ski-swap/seller/me')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
@RequirePermissions('business_seller')
export class SellerSelfController {
  constructor(private readonly sellerSelfService: SellerSelfService) {}

  // ─── Profile ──────────────────────────────────────────────────────────────

  @Get()
  getProfile(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sellerSelfService.getProfile(orgId, user.userId);
  }

  @Patch()
  updateProfile(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PatchSellerDto,
  ) {
    return this.sellerSelfService.updateProfile(orgId, user.userId, body);
  }

  // ─── Active swaps (swap selector) ─────────────────────────────────────────

  @Get('swaps')
  listSwaps(@Param('orgId') orgId: string) {
    return this.sellerSelfService.listActiveSwaps(orgId);
  }

  // ─── Items ────────────────────────────────────────────────────────────────

  @Get('items')
  listItems(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('swapId') swapId?: string,
  ) {
    return this.sellerSelfService.listItems(orgId, user.userId, swapId);
  }

  @Post('items')
  createItem(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SellerItemCreateDto,
  ) {
    return this.sellerSelfService.createItem(orgId, user.userId, body);
  }

  @Get('items/:itemId')
  getItem(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
  ) {
    return this.sellerSelfService.getItem(orgId, user.userId, itemId);
  }

  @Patch('items/:itemId')
  updateItem(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
    @Body() body: SellerItemUpdateDto,
  ) {
    return this.sellerSelfService.updateItem(orgId, user.userId, itemId, body);
  }

  @Delete('items/:itemId')
  @HttpCode(204)
  deleteItem(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
  ) {
    return this.sellerSelfService.deleteItem(orgId, user.userId, itemId);
  }

  // ─── Photos ───────────────────────────────────────────────────────────────

  @Post('items/:itemId/photos')
  @UseInterceptors(FileInterceptor('image'))
  uploadPhoto(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.sellerSelfService.uploadPhoto(orgId, user.userId, itemId, file);
  }

  @Delete('items/:itemId/photos/:photoId')
  @HttpCode(204)
  deletePhoto(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
    @Param('photoId') photoId: string,
  ) {
    return this.sellerSelfService.deletePhoto(orgId, user.userId, itemId, photoId);
  }
}
