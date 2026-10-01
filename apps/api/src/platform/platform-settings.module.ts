import { Global, Module } from '@nestjs/common';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformSettingsController, PublicFeaturesController } from './platform-settings.controller';

/** Global, because texting is asked about from auth, check-in, receipts and payouts alike. */
@Global()
@Module({
  controllers: [PlatformSettingsController, PublicFeaturesController],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
