import { Module } from '@nestjs/common';
import { IdempotencyService } from '../common/services/idempotency.service';
import { SkuService } from './sku.service';
import { LabelRendererService } from './printing/label-renderer.service';
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
import { PublicSellerService } from './public-seller.service';
import { PublicSellerController } from './public-seller.controller';
import { S3Service } from './s3.service';
import { SquarePosAdapterFactory } from './pos/square.pos.adapter';
import { PosAdapterFactory } from './pos/pos.adapter';
import { SellerSelfService } from './seller-self.service';
import { SellerSelfController } from './seller-self.controller';
import { BusinessSellerService } from './business-seller.service';
import { BusinessSellerController } from './business-seller.controller';
import { PrinterService } from './printer.service';
import { PrinterController } from './printer.controller';
import { StationService } from './station.service';
import { StationController } from './station.controller';
import { PrintQueueService } from './print-queue.service';
import { PrintJobController } from './print-job.controller';
import { SkiSwapSettingsService } from './ski-swap-settings.service';
import { SkiSwapSettingsController } from './ski-swap-settings.controller';
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
    PublicSellerController,
    SellerSelfController,
    BusinessSellerController,
    PrinterController,
    SkiSwapSettingsController,
    StationController,
    PrintJobController,
  ],
  providers: [
    IdempotencyService,
    SkuService,
    LabelRendererService,
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
    PublicSellerService,
    SellerSelfService,
    BusinessSellerService,
    PrinterService,
    SkiSwapSettingsService,
    StationService,
    PrintQueueService,
  ],
  exports: [SquareCryptoService, SquareClientService],
})
export class SkiSwapModule {}
