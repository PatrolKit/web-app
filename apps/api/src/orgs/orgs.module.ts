import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';
import { ResortController } from './resort.controller';
import { ResortService } from './resort.service';
import { S3Service } from '../ski-swap/s3.service';

@Module({
  imports: [AuthModule, PermissionsModule],
  controllers: [OrgsController, ResortController],
  providers: [OrgsService, ResortService, S3Service],
})
export class OrgsModule {}
