import { Module } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service';
import { BootstrapAdminService } from './bootstrap-admin.service';
import { BootstrapAdminController } from './bootstrap-admin.controller';
import { AptIndexService } from './apt-index.service';

/**
 * What a device installs, and who decides.
 *
 * Platform-scoped throughout: there is no org anywhere in here. The fleet runs
 * PatrolKit's software from PatrolKit's repository, and an org that could name
 * its own would be naming what runs on hardware we support.
 */
@Module({
  controllers: [BootstrapAdminController],
  providers: [BootstrapService, BootstrapAdminService, AptIndexService],
  exports: [BootstrapService, AptIndexService],
})
export class BootstrapModule {}
