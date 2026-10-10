import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  CreditSaleDto, CreditSuggestedDto, FeeHandledDto, IgnoreCategoryDto, IssueAndCreditDto, NotSwapSaleDto,
} from '../contracts/sales-check.contracts';
import { SalesCheckService } from './sales-check.service';

/**
 * Sales check (Plan 48). Reading needs `ski_swap:report` and changes nothing
 * (D13). Every change is a POST naming one choice, and needs `ski_swap:admin`.
 */
@Controller('orgs/:orgId/ski-swap/swaps/:swapId/sales-check')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class SalesCheckController {
  constructor(private readonly salesCheck: SalesCheckService) {}

  @Get()
  @RequirePermissions('ski_swap:report')
  list(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.salesCheck.list(orgId, swapId);
  }

  /** The dashboard card's count. */
  @Get('count')
  @RequirePermissions('ski_swap:report')
  count(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.salesCheck.count(orgId, swapId);
  }

  @Post('credit')
  @RequirePermissions('ski_swap:admin')
  credit(
    @Param('orgId') orgId: string, @Param('swapId') swapId: string, @Body() body: CreditSaleDto,
    @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') key?: string,
  ) {
    return this.salesCheck.credit(orgId, swapId, body, user.userId, key);
  }

  @Post('credit-suggested')
  @RequirePermissions('ski_swap:admin')
  creditSuggested(
    @Param('orgId') orgId: string, @Param('swapId') swapId: string, @Body() body: CreditSuggestedDto,
    @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') key?: string,
  ) {
    return this.salesCheck.creditMany(orgId, swapId, body, user.userId, key);
  }

  @Post('not-swap')
  @RequirePermissions('ski_swap:admin')
  notSwap(
    @Param('orgId') orgId: string, @Param('swapId') swapId: string, @Body() body: NotSwapSaleDto,
    @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') key?: string,
  ) {
    return this.salesCheck.notSwapSale(orgId, swapId, body, user.userId, key);
  }

  /** A fee refunded some way Square doesn't show: marked handled. */
  @Post('fee-handled')
  @RequirePermissions('ski_swap:admin')
  feeHandled(
    @Param('orgId') orgId: string, @Param('swapId') swapId: string, @Body() body: FeeHandledDto,
    @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') key?: string,
  ) {
    return this.salesCheck.feeHandled(orgId, swapId, body, user.userId, key);
  }

  @Post('undo/:decisionId')
  @RequirePermissions('ski_swap:admin')
  undo(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('decisionId') decisionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.salesCheck.undo(orgId, swapId, decisionId, user.userId);
  }

  @Post('restock/:itemId')
  @RequirePermissions('ski_swap:admin')
  restock(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('itemId') itemId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.salesCheck.restock(orgId, swapId, itemId, user.userId);
  }

  @Post('ignore-category')
  @RequirePermissions('ski_swap:admin')
  ignoreCategory(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Body() body: IgnoreCategoryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.salesCheck.ignoreCategory(orgId, swapId, body, user.userId);
  }

  @Post('issue-and-credit')
  @RequirePermissions('ski_swap:admin')
  issueAndCredit(
    @Param('orgId') orgId: string, @Param('swapId') swapId: string, @Body() body: IssueAndCreditDto,
    @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') key?: string,
  ) {
    return this.salesCheck.issueAndCredit(orgId, swapId, body, user.userId, key);
  }
}
