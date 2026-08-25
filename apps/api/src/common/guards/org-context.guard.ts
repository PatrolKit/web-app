import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from './jwt-auth.guard';
import type { AuthenticatedDevice } from './device-auth.guard';

export interface OrgMembership {
  id: string;
  orgId: string;
  userId: string;
  org: { id: string; name: string; slug: string; status: string };
}

@Injectable()
export class OrgContextGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser; device?: AuthenticatedDevice; membership?: OrgMembership; params: Record<string, string> }>();

    if (req.device) return true;

    const orgId = req.params['orgId'];
    const userId = req.user?.userId;

    if (!orgId || !userId) throw new ForbiddenException('Missing org or user context');

    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId, orgId } },
      include: { org: true },
    });

    if (!membership || membership.deletedAt !== null || membership.org.status !== 'active') {
      throw new ForbiddenException('Not an active member of this organization');
    }

    req.membership = {
      id: membership.id,
      orgId: membership.orgId,
      userId: membership.userId,
      org: {
        id: membership.org.id,
        name: membership.org.name,
        slug: membership.org.slug,
        status: membership.org.status,
      },
    };

    return true;
  }
}
