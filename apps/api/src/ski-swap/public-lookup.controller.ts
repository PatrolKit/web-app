import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PublicLookupService } from './public-lookup.service';

@Controller('public/:orgSlug/ski-swap')
@Throttle({ default: { ttl: 60_000, limit: 20 } })
export class PublicLookupController {
  constructor(private readonly lookupService: PublicLookupService) {}

  @Get('seller-lookup')
  lookup(
    @Param('orgSlug') orgSlug: string,
    @Query('phone') phone: string,
    @Query('swapId') swapId?: string,
  ) {
    if (!phone) throw new BadRequestException('phone query param is required');
    return this.lookupService.lookup(orgSlug, phone, swapId);
  }
}
