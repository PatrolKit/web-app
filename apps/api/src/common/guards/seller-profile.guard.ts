import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from './jwt-auth.guard';

export interface CallerSellerProfile {
  id: string;
  businessName: string | null;
  /** Business sellers get bulk entry and printer assignment; individuals do not. */
  isBusiness: boolean;
}

/**
 * Replaces `@RequirePermissions('business_seller')`. Self-service is granted by
 * *having a live seller profile at this org*, not by a permission — individual
 * sellers now reach the same endpoints by the same route.
 */
@Injectable()
export class SellerProfileGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<
      Request & { user?: AuthenticatedUser; sellerProfile?: CallerSellerProfile; params: Record<string, string> }
    >();

    const orgId = req.params['orgId'];
    const userId = req.user?.userId;
    if (!orgId || !userId) throw new ForbiddenException('Missing org or user context');

    const profile = await this.prisma.sellerProfile.findFirst({
      where: { deletedAt: null, membership: { orgId, userId, deletedAt: null } },
      select: { id: true, businessName: true },
    });
    if (!profile) throw new ForbiddenException('Not a seller in this organization');

    req.sellerProfile = {
      id: profile.id,
      businessName: profile.businessName,
      isBusiness: profile.businessName !== null,
    };
    return true;
  }
}
