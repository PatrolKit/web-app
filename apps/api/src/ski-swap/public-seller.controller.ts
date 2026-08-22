import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PublicSellerService } from './public-seller.service';
import { SellerVerificationService } from './seller-verification.service';
import { ConfirmEmailVerificationDto, ConfirmPhoneVerificationDto } from '../contracts/ski-swap.contracts';

@Controller('public/sellers')
@Throttle({ default: { ttl: 60_000, limit: 20 } })
export class PublicSellerController {
  constructor(
    private readonly publicSellerService: PublicSellerService,
    private readonly verificationService: SellerVerificationService,
  ) {}

  @Get(':sellerId')
  getById(@Param('sellerId') sellerId: string) {
    return this.publicSellerService.getById(sellerId);
  }

  @Post(':sellerId/verify/email/confirm')
  @HttpCode(200)
  @Throttle({ default: { ttl: 600_000, limit: 5 } })
  async confirmEmail(
    @Param('sellerId') sellerId: string,
    @Body() body: ConfirmEmailVerificationDto,
  ) {
    await this.verificationService.confirmEmail(sellerId, body.token);
    return { verified: true };
  }

  @Post(':sellerId/verify/phone/confirm')
  @HttpCode(200)
  @Throttle({ default: { ttl: 600_000, limit: 5 } })
  async confirmPhone(
    @Param('sellerId') sellerId: string,
    @Body() body: ConfirmPhoneVerificationDto,
  ) {
    await this.verificationService.confirmPhone(sellerId, body.code);
    return { verified: true };
  }
}
