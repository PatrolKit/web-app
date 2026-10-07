import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { OrDeviceAuthGuard } from '../../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../../common/decorators/require-device-role.decorator';
import { IndemnificationLookupService } from './indemnification-lookup.service';
import { LookupSearchQueryDto } from '../../contracts/indemnification.contracts';

/**
 * The lookup, for the patrol's staff and its check-in iPads (Plan 44 D10).
 *
 * Not for sellers. They are members of the patrol too, with no ski-swap
 * permission, and a business seller is a retail shop: exactly who NSSRA's
 * members-only list is kept from. `ski_swap:report` is the staff floor, as on
 * the Items list. Never under `public/*`.
 */
@Controller('orgs/:orgId/ski-swap/bindings/indemnification')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireDeviceRole('ski_swap.staff_check_in')
@RequirePermissions('ski_swap:report')
@RequireModule('ski_swap')
export class IndemnificationController {
  constructor(private readonly lookup: IndemnificationLookupService) {}

  @Get('manufacturers')
  manufacturers(@Param('orgId') orgId: string) {
    return this.lookup.manufacturers(orgId);
  }

  @Get('manufacturers/:nodeId/models')
  models(@Param('orgId') orgId: string, @Param('nodeId') nodeId: string) {
    return this.lookup.models(orgId, nodeId);
  }

  @Get('search')
  search(@Param('orgId') orgId: string, @Query() query: LookupSearchQueryDto) {
    return this.lookup.search(orgId, query.q);
  }

  @Get('models/:nodeId')
  model(@Param('orgId') orgId: string, @Param('nodeId') nodeId: string) {
    return this.lookup.model(orgId, nodeId);
  }
}
