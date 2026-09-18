import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, type AuthenticatedUser } from '../../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PayoutRunService } from './payout-run.service';
import {
  ApproveLinesDto,
  CreatePayoutRunDto,
  RecordCheckDto,
  SendPayoutRunDto,
} from '../../contracts/payouts.contracts';

/**
 * Payout runs (Plan 25 §4–§10).
 *
 * Reading a run is `ski_swap:report` — a swap chair should be able to see what
 * is owed. Everything that approves, sends or records a payment is
 * `ski_swap:admin`, per route rather than on the class, so adding a route here
 * does not quietly inherit the right to move money.
 */
@Controller('orgs/:orgId/ski-swap')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class PayoutRunController {
  constructor(private readonly runs: PayoutRunService) {}

  @Get('payout-runs')
  @RequirePermissions('ski_swap:report')
  list(@Param('orgId') orgId: string, @Query('swapId') swapId?: string) {
    return this.runs.list(orgId, swapId);
  }

  @Post('swaps/:swapId/payout-runs')
  @RequirePermissions('ski_swap:admin')
  create(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Body() body: CreatePayoutRunDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.create(orgId, swapId, user.userId, body);
  }

  @Get('payout-runs/:runId')
  @RequirePermissions('ski_swap:report')
  get(@Param('orgId') orgId: string, @Param('runId') runId: string) {
    return this.runs.get(orgId, runId);
  }

  @Get('payout-runs/:runId/discounts')
  @RequirePermissions('ski_swap:report')
  discounts(@Param('orgId') orgId: string, @Param('runId') runId: string) {
    return this.runs.discounts(orgId, runId);
  }

  @Post('payout-runs/:runId/approve')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  approve(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Body() body: ApproveLinesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.approve(orgId, runId, body.lineIds, body.approved, user.userId);
  }

  @Post('payout-runs/:runId/send')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  send(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Body() body: SendPayoutRunDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.send(orgId, runId, body.expectedLineCount, user.userId);
  }

  @Post('payout-runs/:runId/close')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  close(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.close(orgId, runId, user.userId);
  }

  @Get('payout-runs/:runId/checks')
  @RequirePermissions('ski_swap:report')
  checks(@Param('orgId') orgId: string, @Param('runId') runId: string) {
    return this.runs.checks(orgId, runId);
  }

  @Get('payout-runs/:runId/checks.csv')
  @RequirePermissions('ski_swap:report')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async checksCsv(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Res() res: Response,
  ) {
    const csv = await this.runs.checksCsv(orgId, runId);
    res.setHeader('Content-Disposition', `attachment; filename="checks-${runId}.csv"`);
    // A BOM, so Excel opens it as UTF-8 rather than guessing at a name with an
    // accent in it.
    res.send('﻿' + csv);
  }

  @Post('payout-runs/:runId/lines/:lineId/check')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  recordCheck(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Param('lineId') lineId: string,
    @Body() body: RecordCheckDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.recordCheck(orgId, runId, lineId, body, user.userId);
  }
}
