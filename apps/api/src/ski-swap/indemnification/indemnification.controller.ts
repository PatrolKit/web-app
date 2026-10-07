import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { IndemnificationLookupService } from './indemnification-lookup.service';
import { LookupSearchQueryDto } from '../../contracts/indemnification.contracts';

/**
 * The lookup, for anyone in the patrol (Plan 44 D10).
 *
 * Membership and nothing more: `OrgContextGuard` has proven an active
 * membership, and the point is a glance at check-in by whoever is standing
 * there. `JwtAuthGuard` rather than the device-or-user guard: no iPad reads
 * this yet (D13), and the handoff says when that changes. Never under
 * `public/*`.
 */
@Controller('orgs/:orgId/ski-swap/bindings/indemnification')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
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
