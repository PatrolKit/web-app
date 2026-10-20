import { Body, Controller, Get, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type AuthenticatedUser } from '../../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateCompDto, UndoCompDto } from '../../contracts/comps.contracts';
import { SwapCompService } from './swap-comp.service';

/**
 * Comps (Plan 53). The list needs `ski_swap:report`; comping and undoing need
 * `ski_swap:admin`, Ski Swap admins only (D9).
 */
@Controller('orgs/:orgId/ski-swap/swaps/:swapId')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class SwapCompController {
  constructor(private readonly comps: SwapCompService) {}

  @Get('comps')
  @RequirePermissions('ski_swap:report')
  list(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.comps.list(orgId, swapId);
  }

  @Post('items/:itemId/comp')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  create(
    @Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('itemId') itemId: string,
    @Body() body: CreateCompDto, @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') key?: string,
  ) {
    return this.comps.create(orgId, swapId, itemId, body, user.userId, key);
  }

  @Post('comps/:compId/undo')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  undo(
    @Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('compId') compId: string,
    @Body() body: UndoCompDto, @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.comps.undo(orgId, swapId, compId, body.note, user.userId);
  }
}
