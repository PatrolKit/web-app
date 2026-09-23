import { Global, Module } from '@nestjs/common';
import { AttributionResolver } from './attribution-resolver.service';
import { LimitUsageService } from './limit-usage.service';

/** The limit registry's runtime half: counting, and remembering the counts. */
@Global()
@Module({
  providers: [AttributionResolver, LimitUsageService],
  exports: [AttributionResolver, LimitUsageService],
})
export class LimitsModule {}
