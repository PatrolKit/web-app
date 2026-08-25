import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PublicSellerService } from './public-seller.service';

@Controller('public/sellers')
@Throttle({ default: { ttl: 60_000, limit: 20 } })
export class PublicSellerController {
  constructor(private readonly publicSellerService: PublicSellerService) {}

  @Get(':sellerId')
  getById(@Param('sellerId') sellerId: string) {
    return this.publicSellerService.getById(sellerId);
  }
}
