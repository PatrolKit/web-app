import { Module } from '@nestjs/common';
import { ModulesController } from './modules.controller';
import { ModulesService } from './modules.service';
import { TimeClockModule } from '../time-clock/time-clock.module';

@Module({
  imports: [TimeClockModule],
  controllers: [ModulesController],
  providers: [ModulesService],
})
export class OrgModulesModule {}
