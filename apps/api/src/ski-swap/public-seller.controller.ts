import { Controller, Get, Param } from '@nestjs/common';
import { Limit } from '../common/limits/limit.decorator';
import { PublicSellerService } from './public-seller.service';

@Controller('public/sellers')
@Limit('public.reads')
export class PublicSellerController {
  constructor(private readonly publicSellerService: PublicSellerService) {}

  @Get(':sellerId')
  getById(@Param('sellerId') sellerId: string) {
    return this.publicSellerService.getById(sellerId);
  }
}
