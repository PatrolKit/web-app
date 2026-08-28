import { Module } from '@nestjs/common';
import { PlatformController, PlatformUsersController } from './platform.controller';
import { PlatformService } from './platform.service';

@Module({
  controllers: [PlatformController, PlatformUsersController],
  providers: [PlatformService],
})
export class PlatformModule {}
