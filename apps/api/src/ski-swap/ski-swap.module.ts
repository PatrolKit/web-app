import { Module } from '@nestjs/common';
import { SquareCryptoService } from './square-crypto.service';
import { SquareClientService } from './square-client.service';
import { SquareConfigService } from './square-config.service';
import { SquareConfigController } from './square-config.controller';
import { SwapService } from './swap.service';
import { SwapController } from './swap.controller';
import { SellerService } from './seller.service';
import { SellerController } from './seller.controller';
import { ItemService } from './item.service';
import { ItemController } from './item.controller';
import { StatsService } from './stats.service';
import { StatsController } from './stats.controller';
import { PublicLookupService } from './public-lookup.service';
import { PublicLookupController } from './public-lookup.controller';
import { S3Service } from './s3.service';
import { SquarePosAdapterFactory } from './pos/square.pos.adapter';
import { PosAdapterFactory } from './pos/pos.adapter';
import { SellerSelfService } from './seller-self.service';
import { SellerSelfController } from './seller-self.controller';
import { BusinessSellerService } from './business-seller.service';
import { BusinessSellerController } from './business-seller.controller';
import { AuthModule } from '../auth/auth.module';
import { PermissionsModule } from '../permissions/permissions.module';

@Module({
  imports: [AuthModule, PermissionsModule],
  controllers: [
    SquareConfigController,
    SwapController,
    SellerController,
    ItemController,
    StatsController,
    PublicLookupController,
    SellerSelfController,
    BusinessSellerController,
  ],
  providers: [
    SquareCryptoService,
    SquareClientService,
    SquareConfigService,
    S3Service,
    { provide: PosAdapterFactory, useClass: SquarePosAdapterFactory },
    SwapService,
    SellerService,
    ItemService,
    StatsService,
    PublicLookupService,
    SellerSelfService,
    BusinessSellerService,
  ],
  exports: [SquareCryptoService, SquareClientService],
})
export class SkiSwapModule {}
