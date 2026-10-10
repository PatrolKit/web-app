import { Module } from '@nestjs/common';
import { IdempotencyService } from '../common/services/idempotency.service';
import { SkuService } from './sku.service';
import { LabelRendererService } from './printing/label-renderer.service';
import { PrintRecipeService } from './printing/print-recipe.service';
import { LabelRenderService } from './printing/label-render.service';
import { CredentialCryptoService } from '../common/services/credential-crypto.service';
import { SquareClientService } from './square-client.service';
import { SquareConfigService } from './square-config.service';
import { SquareConfigController } from './square-config.controller';
import { SwapService } from './swap.service';
import { SwapController } from './swap.controller';
import { SellerService } from './seller.service';
import { SellerController } from './seller.controller';
import { ItemService } from './item.service';
import { ItemCategorizeService } from './item-categorize.service';
import { ItemReturnService } from './item-return.service';
import { ItemController } from './item.controller';
import { StatsService } from './stats.service';
import { ItemBreakdownService } from './item-breakdown.service';
import { StatsController } from './stats.controller';
import { PublicLookupService } from './public-lookup.service';
import { PublicLookupController } from './public-lookup.controller';
import { PublicStatusService } from './public-status.service';
import { PublicStatusController } from './public-status.controller';
import { PublicSellerService } from './public-seller.service';
import { PublicSellerController } from './public-seller.controller';
import { S3Service } from './s3.service';
import { SquarePosAdapterFactory } from './pos/square.pos.adapter';
import { PosAdapterFactory } from './pos/pos.adapter';
import { SellerSelfService } from './seller-self.service';
import { LegacyTicketService } from './legacy-ticket.service';
import { IssuedTicketService } from './issued-ticket.service';
import { SellerSelfController } from './seller-self.controller';
import { BusinessSellerService } from './business-seller.service';
import { BusinessSellerController } from './business-seller.controller';
import { PrinterService } from './printer.service';
import { ScannerService } from './scanner.service';
import { ScanService } from './scan.service';
import { ScanController } from './scan.controller';
import { ScannerController } from './scanner.controller';
import { PrinterController } from './printer.controller';
import { CheckinService } from './checkin.service';
import {
  ReceiptController,
  SellerReceiptController,
  PublicReceiptController,
} from './receipt.controller';
import { ReceiptService } from './receipt.service';
import { CheckinController, PublicCheckinController } from './checkin.controller';
import { StationService } from './station.service';
import { StationController } from './station.controller';
import { StationPrintController } from './station-print.controller';
import { PrintQueueService } from './print-queue.service';
import { QrSheetService } from './printing/qr-sheet.service';
import { PrintJobController } from './print-job.controller';
import { SkiSwapSettingsService } from './ski-swap-settings.service';
import { SkiSwapSettingsController } from './ski-swap-settings.controller';
import { TaxonomyService } from './taxonomy/taxonomy.service';
import { TaxonomyIconService } from './taxonomy/taxonomy-icon.service';
import { TaxonomyController } from './taxonomy/taxonomy.controller';
import {
  TaxonomyAdminController,
  TaxonomyAdminIconController,
} from './taxonomy/taxonomy-admin.controller';
import { PayPalClient, HttpPayPalClient } from './payouts/paypal.client';
import { PayPalConfigService } from './payouts/paypal-config.service';
import { PayPalConfigController } from './payouts/paypal-config.controller';
import { PayoutRunService } from './payouts/payout-run.service';
import { PayoutRunController } from './payouts/payout-run.controller';
import { PayoutNudgeService } from './payouts/payout-nudge.service';
import { PayoutWebhookController } from './payouts/payout-webhook.controller';
import { StubPayPalClient, StubPosAdapterFactory, payoutStubsEnabled } from './payouts/stub.providers';
import { AuthModule } from '../auth/auth.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { IdentityModule } from '../common/identity/identity.module';
import { SwapDiagnosticsController } from './diagnostics/swap-diagnostics.controller';
import { SalesCheckController } from './sales-check.controller';
import { IssueNotesController } from './issue-notes.controller';
import { IssueNotesService } from './issue-notes.service';
import { SalesCheckService } from './sales-check.service';
import { SwapDiagnosticsService } from './diagnostics/swap-diagnostics.service';
import { IndemnificationController } from './indemnification/indemnification.controller';
import { IndemnificationAdminController } from './indemnification/indemnification-admin.controller';
import { IndemnificationLookupService } from './indemnification/indemnification-lookup.service';
import { IndemnificationImportService } from './indemnification/indemnification-import.service';

@Module({
  imports: [AuthModule, PermissionsModule, IdentityModule],
  controllers: [
    ScannerController,
    ScanController,
    SquareConfigController,
    PayPalConfigController,
    PayoutRunController,
    PayoutWebhookController,
    SwapController,
    SellerController,
    ItemController,
    StatsController,
    PublicLookupController,
    PublicStatusController,
    PublicSellerController,
    SellerSelfController,
    BusinessSellerController,
    PrinterController,
    SkiSwapSettingsController,
    StationController,
    StationPrintController,
    CheckinController,
    PublicCheckinController,
    PrintJobController,
    TaxonomyController,
    TaxonomyAdminController,
    TaxonomyAdminIconController,
    ReceiptController,
    SellerReceiptController,
    PublicReceiptController,
    SwapDiagnosticsController,
    SalesCheckController,
    IssueNotesController,
    IndemnificationController,
    IndemnificationAdminController,
  ],
  providers: [
    ReceiptService,
    IdempotencyService,
    SkuService,
    LabelRendererService,
    PrintRecipeService,
    LabelRenderService,
    CredentialCryptoService,
    SquareClientService,
    SquareConfigService,
    // The test doubles only when `PAYOUTS_STUB=1`, which throws in production.
    // Chosen here rather than inside the services so that nothing downstream
    // has to know, or can be tempted to check, which one it is talking to.
    { provide: PayPalClient, useClass: payoutStubsEnabled() ? StubPayPalClient : HttpPayPalClient },
    PayPalConfigService,
    PayoutRunService,
    PayoutNudgeService,
    S3Service,
    {
      provide: PosAdapterFactory,
      useClass: payoutStubsEnabled() ? StubPosAdapterFactory : SquarePosAdapterFactory,
    },
    SwapService,
    SellerService,
    ItemService,
    ItemReturnService,
    ItemCategorizeService,
    StatsService,
    ItemBreakdownService,
    SalesCheckService,
    IssueNotesService,
    PublicLookupService,
    PublicStatusService,
    PublicSellerService,
    SellerSelfService,
    LegacyTicketService,
    IssuedTicketService,
    BusinessSellerService,
    PrinterService,
    ScannerService,
    ScanService,
    SkiSwapSettingsService,
    StationService,
    CheckinService,
    PrintQueueService,
    QrSheetService,
    SwapDiagnosticsService,
    TaxonomyService,
    TaxonomyIconService,
    IndemnificationLookupService,
    IndemnificationImportService,
  ],
  exports: [CredentialCryptoService, SquareClientService],
})
export class SkiSwapModule {}
