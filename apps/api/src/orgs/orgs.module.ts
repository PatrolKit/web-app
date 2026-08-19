import { Module } from '@nestjs/common';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';
import { S3Service } from '../ski-swap/s3.service';

@Module({
  controllers: [OrgsController],
  providers: [OrgsService, S3Service],
})
export class OrgsModule {}
