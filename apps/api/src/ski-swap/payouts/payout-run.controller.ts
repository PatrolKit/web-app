import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { PayoutsExportService } from './payouts-export.service';
import { JwtAuthGuard, type AuthenticatedUser } from '../../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PayoutRunService } from './payout-run.service';
import { PayoutNudgeService } from './payout-nudge.service';
import {
  AddPayoutSellersDto,
  ApproveAllDto,
  EmailPayoutsExportDto,
  ApproveLineDto,
  CreatePayoutRunDto,
  SendPayoutRunDto,
  SettlePayoutLineDto,
} from '../../contracts/payouts.contracts';

/**
 * Payout runs, built by hand (Plan 52).
 *
 * Reading a run is `ski_swap:report` — a swap chair should be able to see what
 * is owed. Everything that builds, approves, sends or records a payment is
 * `ski_swap:admin`, per route rather than on the class, so adding a route here
 * does not quietly inherit the right to move money.
 */
@Controller('orgs/:orgId/ski-swap')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class PayoutRunController {
  constructor(
    private readonly runs: PayoutRunService,
    private readonly nudges: PayoutNudgeService,
    private readonly exports: PayoutsExportService,
  ) {}

  /** The Payouts page: the runs, and everything to fix before paying. */
  @Get('swaps/:swapId/payouts-summary')
  @RequirePermissions('ski_swap:report')
  summary(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.runs.summary(orgId, swapId);
  }

  @Post('swaps/:swapId/payout-runs')
  @RequirePermissions('ski_swap:admin')
  create(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Body() body: CreatePayoutRunDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.create(orgId, swapId, body.kind, user.userId);
  }

  /** PayPal's available balance, for "can PayPal cover this run". Reads only. */
  @Get('paypal-balance')
  @RequirePermissions('ski_swap:report')
  paypalBalance(@Param('orgId') orgId: string) {
    return this.runs.paypalBalance(orgId);
  }

  @Get('payout-runs/:runId')
  @RequirePermissions('ski_swap:report')
  get(@Param('orgId') orgId: string, @Param('runId') runId: string) {
    return this.runs.get(orgId, runId);
  }

  /** Only an empty run (D15). */
  @Delete('payout-runs/:runId')
  @RequirePermissions('ski_swap:admin')
  remove(@Param('orgId') orgId: string, @Param('runId') runId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.runs.remove(orgId, runId, user.userId);
  }

  /** The sellers this run can take (D3). */
  @Get('payout-runs/:runId/choices')
  @RequirePermissions('ski_swap:report')
  choices(@Param('orgId') orgId: string, @Param('runId') runId: string) {
    return this.runs.choices(orgId, runId);
  }

  @Post('payout-runs/:runId/sellers')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  addSellers(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Body() body: AddPayoutSellersDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.addSellers(orgId, runId, body.sellerIds, user.userId);
  }

  @Delete('payout-runs/:runId/sellers/:sellerId')
  @RequirePermissions('ski_swap:admin')
  removeSeller(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Param('sellerId') sellerId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.removeSeller(orgId, runId, sellerId, user.userId);
  }

  /** Approve all: every seller the confirmation listed, at the totals it showed. */
  @Post('payout-runs/:runId/approve-all')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  approveAll(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Body() body: ApproveAllDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.approveAll(orgId, runId, body.lines, user.userId);
  }

  @Post('payout-runs/:runId/lines/:lineId/approve')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  approve(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Param('lineId') lineId: string,
    @Body() body: ApproveLineDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.approve(orgId, runId, lineId, body.approved, user.userId);
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

  /** A check run: freeze everyone, close it, and export (D13). */
  @Post('payout-runs/:runId/close-checks')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  closeChecks(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Body() body: SendPayoutRunDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.closeChecks(orgId, runId, body.expectedLineCount, user.userId);
  }

  /** The Payouts export: payouts by seller, for every seller of the swap with sales. */
  @Get('swaps/:swapId/payouts/export')
  @RequirePermissions('ski_swap:report')
  async exportPayouts(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @CurrentUser() user: AuthenticatedUser, @Res() res: Response) {
    sendFile(res, await this.exports.download(orgId, { swapId }, user.userId));
  }

  @Post('swaps/:swapId/payouts/export/email')
  @HttpCode(200)
  @RequirePermissions('ski_swap:report')
  emailPayouts(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Body() body: EmailPayoutsExportDto, @CurrentUser() user: AuthenticatedUser) {
    return this.exports.email(orgId, { swapId }, body.to, user.userId);
  }

  /** The same, for one run's sellers. */
  @Get('payout-runs/:runId/export')
  @RequirePermissions('ski_swap:report')
  async exportRun(@Param('orgId') orgId: string, @Param('runId') runId: string, @CurrentUser() user: AuthenticatedUser, @Res() res: Response) {
    sendFile(res, await this.exports.download(orgId, { runId }, user.userId));
  }

  @Post('payout-runs/:runId/export/email')
  @HttpCode(200)
  @RequirePermissions('ski_swap:report')
  emailRun(@Param('orgId') orgId: string, @Param('runId') runId: string, @Body() body: EmailPayoutsExportDto, @CurrentUser() user: AuthenticatedUser) {
    return this.exports.email(orgId, { runId }, body.to, user.userId);
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
    res.send('\ufeff' + csv);
  }

  /** A change after payment, settled outside PatrolKit (D9). */
  @Post('payout-runs/:runId/lines/:lineId/settle')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  settle(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Param('lineId') lineId: string,
    @Body() body: SettlePayoutLineDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.settle(orgId, runId, lineId, body.note, user.userId);
  }

  /** An unclaimed payment, cancelled at PayPal: final in this run (D19). */
  @Post('payout-runs/:runId/lines/:lineId/cancel-payment')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  cancelPayment(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Param('lineId') lineId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.runs.cancelPayment(orgId, runId, lineId, user.userId);
  }

  /** "Remind them": the unclaimed-payout email or text, now (D19). */
  @Post('payout-runs/:runId/lines/:lineId/remind')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  remind(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Param('lineId') lineId: string,
  ) {
    return this.nudges.remind(orgId, runId, lineId);
  }

  /** "Check with PayPal" on one run. */
  @Post('payout-runs/:runId/reconcile')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  reconcileRun(@Param('orgId') orgId: string, @Param('runId') runId: string) {
    return this.runs.reconcileRun(orgId, runId);
  }

  /**
   * Asks PayPal what happened to everything still moving (§8): for a schedule,
   * or a person who wants an answer now.
   */
  @Post('payout-runs/reconcile')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  reconcile(@Param('orgId') orgId: string) {
    return this.runs.reconcileOrg(orgId);
  }

  /** Sends whichever unclaimed-payout nudges have come due (§9). */
  @Post('payout-runs/nudge')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  nudge(@Param('orgId') orgId: string) {
    return this.nudges.sweep(orgId);
  }
}

/** A spreadsheet, as a download. */
function sendFile(res: Response, file: { filename: string; contentType: string; content: Buffer }) {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(file.content);
}
