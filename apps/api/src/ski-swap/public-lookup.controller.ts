import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { Limit } from '../common/limits/limit.decorator';
import { PublicLookupService } from './public-lookup.service';

@Controller('public/:orgSlug/ski-swap')
@Limit('public.reads')
export class PublicLookupController {
  constructor(private readonly lookupService: PublicLookupService) {}

  @Get('branding')
  branding(@Param('orgSlug') orgSlug: string) {
    return this.lookupService.getOrgBranding(orgSlug);
  }

  @Get('seller-find')
  findSeller(
    @Param('orgSlug') orgSlug: string,
    @Query('email') email: string,
    @Query('last4') last4: string,
  ) {
    if (!email || !last4) throw new BadRequestException('email and last4 query params are required');
    if (!/^\d{4}$/.test(last4)) throw new BadRequestException('last4 must be exactly 4 digits');
    return this.lookupService.findByEmailAndLast4(orgSlug, email, last4);
  }
}
