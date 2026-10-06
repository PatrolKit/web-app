import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type AuthenticatedUser } from '../../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApplyDiagnosticChoiceDto, ApplyDiagnosticChoiceToAllDto } from '../../contracts/swap-diagnostics.contracts';
import { SwapDiagnosticsService } from './swap-diagnostics.service';

/** Swap diagnostics (Plan 41): run the checks, read the latest, choose. Admins only (D12). */
@Controller('orgs/:orgId/ski-swap/swaps/:swapId/diagnostics')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
@RequirePermissions('ski_swap:admin')
export class SwapDiagnosticsController {
  constructor(private readonly diagnostics: SwapDiagnosticsService) {}

  @Post()
  @HttpCode(202)
  start(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.diagnostics.start(orgId, swapId, user.userId);
  }

  @Get('latest')
  latest(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.diagnostics.latest(orgId, swapId);
  }

  @Post('issues/:issueId')
  @HttpCode(200)
  apply(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('issueId') issueId: string,
    @Body() body: ApplyDiagnosticChoiceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { choice, ...extra } = body;
    return this.diagnostics.apply(orgId, swapId, issueId, choice, extra, user.userId);
  }

  @Post('runs/:runId/apply-all')
  @HttpCode(200)
  applyAll(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('runId') runId: string,
    @Body() body: ApplyDiagnosticChoiceToAllDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { kind, field, choice, ...extra } = body;
    return this.diagnostics.applyAll(orgId, swapId, runId, { kind, field }, choice, extra, user.userId);
  }
}
