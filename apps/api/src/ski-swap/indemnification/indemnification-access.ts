import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Who may read binding indemnification (Plan 51). The lists are licensed, so
 * it's off unless a platform admin allows the org, and then on for the web and
 * for the check-in iPads only as the org's own admins switch each on, which
 * certifies the org's right to them.
 */

/** What an org can see, as its settings say it. Web and iPad are only ever on while allowed. */
export interface IndemnificationAccess {
  allowed: boolean;
  web: boolean;
  ipad: boolean;
}

export function accessOf(
  org: { indemnificationAllowed: boolean } | null,
  settings: { indemnificationWeb: boolean; indemnificationIpad: boolean } | null,
): IndemnificationAccess {
  const allowed = org?.indemnificationAllowed ?? false;
  return {
    allowed,
    web: allowed && (settings?.indemnificationWeb ?? false),
    ipad: allowed && (settings?.indemnificationIpad ?? false),
  };
}

/** What an org admin certifies by turning binding indemnification on, for the web or the iPads. */
export const INDEMNIFICATION_CERTIFICATION =
  'By enabling this function you certify that your organization has a right to access this proprietary ' +
  'information, and that you will not copy or distribute it outside the limits of your agreement with the NSSRA.';

/** Why a lookup was refused, for the client that asked. Null when it may read. */
export function refusalOf(access: IndemnificationAccess, client: 'web' | 'ipad'): string | null {
  if (!access.allowed) return 'Binding indemnification isn’t available to this organization.';
  if (client === 'ipad' && !access.ipad) return 'Binding indemnification isn’t turned on for this organization’s iPads.';
  if (client === 'web' && !access.web) return 'Binding indemnification isn’t turned on for this organization on the web.';
  return null;
}

/**
 * Every lookup route: refused, 403 `INDEMNIFICATION_OFF`, unless the org may
 * see the lists on the client asking. A device token is the iPad; a person's
 * is the web. Read per request, so a switch takes effect at once.
 */
@Injectable()
export class IndemnificationAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ params: { orgId?: string }; device?: unknown }>();
    const orgId = req.params.orgId ?? '';
    const [org, settings] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: orgId }, select: { indemnificationAllowed: true } }),
      this.prisma.skiSwapSettings.findUnique({ where: { orgId }, select: { indemnificationWeb: true, indemnificationIpad: true } }),
    ]);
    const why = refusalOf(accessOf(org, settings), req.device ? 'ipad' : 'web');
    if (why) throw new ForbiddenException({ code: 'INDEMNIFICATION_OFF', message: why });
    return true;
  }
}
