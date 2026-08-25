import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtService } from './jwt.service';
import { ContactChallengeService } from './contact-challenge.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, JwtService, ContactChallengeService],
  exports: [JwtService, AuthService, ContactChallengeService],
})
export class AuthModule {}
