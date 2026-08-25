import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { CallerSellerProfile } from '../guards/seller-profile.guard';

/** The seller profile attached by SellerProfileGuard. */
export const CurrentSeller = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CallerSellerProfile =>
    ctx.switchToHttp().getRequest<{ sellerProfile: CallerSellerProfile }>().sellerProfile,
);
