import { Module } from '@nestjs/common';
import { MembersController, PermissionsCatalogController } from './members.controller';
import { MembersService } from './members.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [MembersController, PermissionsCatalogController],
  providers: [MembersService],
})
export class MembersModule {}
