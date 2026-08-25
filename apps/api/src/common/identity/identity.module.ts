import { Global, Module } from '@nestjs/common';
import { MembershipTouchService } from './membership-touch.service';
import { PersonService } from './person.service';

/**
 * Global because the watermark must be bumped from every module that can write
 * a person, a membership, or a profile — wiring it into each one individually
 * is exactly how a write path gets forgotten.
 */
@Global()
@Module({
  providers: [MembershipTouchService, PersonService],
  exports: [MembershipTouchService, PersonService],
})
export class IdentityModule {}
