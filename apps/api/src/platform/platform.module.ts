import { Module } from '@nestjs/common';
import { PlatformController, PlatformUsersController } from './platform.controller';
import { PlatformService } from './platform.service';
import { LimitHealthController } from './limit-health.controller';
import { LimitHealthService } from './limit-health.service';

@Module({
  controllers: [PlatformController, PlatformUsersController, LimitHealthController],
  providers: [PlatformService, LimitHealthService],
})
export class PlatformModule {}
