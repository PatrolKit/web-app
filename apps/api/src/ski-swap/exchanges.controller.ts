import { Body, Controller, Get, Headers, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CancelExchangeDto, EditExchangeDto, RecordExchangeDto } from '../contracts/exchanges.contracts';
import { ExchangesService } from './exchanges.service';

/**
 * Exchanges (Plan 49). The list needs `ski_swap:report` and changes nothing.
 * Looking up a sale, and every change, needs `ski_swap:admin` (D1).
 */
@Controller('orgs/:orgId/ski-swap/swaps/:swapId/exchanges')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class ExchangesController {
  constructor(private readonly exchanges: ExchangesService) {}

  @Get()
  @RequirePermissions('ski_swap:report')
  list(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.exchanges.list(orgId, swapId);
  }

  /** D3: `?receipt=Gq00` or `?ticket=87344`. */
  @Get('lookup')
  @RequirePermissions('ski_swap:admin')
  lookup(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Query('receipt') receipt?: string, @Query('ticket') ticket?: string) {
    return this.exchanges.lookup(orgId, swapId, { receipt, ticket });
  }

  @Post()
  @RequirePermissions('ski_swap:admin')
  record(
    @Param('orgId') orgId: string, @Param('swapId') swapId: string, @Body() body: RecordExchangeDto,
    @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') key?: string,
  ) {
    return this.exchanges.record(orgId, swapId, body, user.userId, key);
  }

  /** The note only: anything else is cancel and record again. */
  @Patch(':id')
  @RequirePermissions('ski_swap:admin')
  edit(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('id') id: string, @Body() body: EditExchangeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.exchanges.editNote(orgId, swapId, id, body.note, user.userId);
  }

  @Post(':id/cancel')
  @RequirePermissions('ski_swap:admin')
  cancel(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('id') id: string, @Body() body: CancelExchangeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.exchanges.cancel(orgId, swapId, id, body.reason, user.userId);
  }

  @Post(':id/retry-stock')
  @RequirePermissions('ski_swap:admin')
  retryStock(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.exchanges.retryStock(orgId, swapId, id, user.userId);
  }
}
