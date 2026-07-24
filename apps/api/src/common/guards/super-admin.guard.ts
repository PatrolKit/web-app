import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from './jwt-auth.guard';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const userId = req.user?.userId;
    if (!userId) throw new ForbiddenException('Authentication required');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.isSuperAdmin) throw new ForbiddenException('Super admin access required');

    return true;
  }
}
