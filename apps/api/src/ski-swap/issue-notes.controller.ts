import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, type AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SaveIssueNoteDto } from '../contracts/issue-notes.contracts';
import { IssueNotesService } from './issue-notes.service';

/**
 * Notes on Reports issues (Plan 48). A note changes nothing in Square, so on
 * Sales check anyone who can read it may write one; Catalog check is an
 * admin's page, notes and all.
 */
@Controller('orgs/:orgId/ski-swap/swaps/:swapId/issue-notes')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class IssueNotesController {
  constructor(private readonly notes: IssueNotesService) {}

  @Get('sales')
  @RequirePermissions('ski_swap:report')
  sales(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.notes.list(orgId, swapId, 'sales');
  }

  @Put('sales')
  @RequirePermissions('ski_swap:report')
  saveSales(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Body() body: SaveIssueNoteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.notes.save(orgId, swapId, 'sales', body, user.userId);
  }

  @Get('catalog')
  @RequirePermissions('ski_swap:admin')
  catalog(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.notes.list(orgId, swapId, 'catalog');
  }

  @Put('catalog')
  @RequirePermissions('ski_swap:admin')
  saveCatalog(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Body() body: SaveIssueNoteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.notes.save(orgId, swapId, 'catalog', body, user.userId);
  }
}
