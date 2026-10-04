import { Controller, Get, Param } from '@nestjs/common';
import { Limit } from '../common/limits/limit.decorator';
import { PublicStatusService } from './public-status.service';

/** Unauthenticated SKU Lookup (Plan 33): `<org>/<swap slug>/status`. */
@Controller('public/:orgSlug/swaps/:swapSlug')
@Limit('public.reads')
export class PublicStatusController {
  constructor(private readonly status: PublicStatusService) {}

  @Get()
  page(@Param('orgSlug') orgSlug: string, @Param('swapSlug') swapSlug: string) {
    return this.status.page(orgSlug, swapSlug);
  }

  /** Tighter than the page: SKUs are sequential, and this is how they'd be stepped through. */
  @Get('sku/:sku')
  @Limit('public.skuLookup')
  sku(@Param('orgSlug') orgSlug: string, @Param('swapSlug') swapSlug: string, @Param('sku') sku: string) {
    return this.status.sku(orgSlug, swapSlug, sku);
  }
}
