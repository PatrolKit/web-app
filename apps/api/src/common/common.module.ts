import { Global, Module } from '@nestjs/common';
import { ModuleAccessService } from './services/module-access.service';

/**
 * Cross-cutting helpers that guards need.
 *
 * Global because `ModuleEnabledGuard` is applied with `@UseGuards` across a
 * dozen feature modules, and a guard is constructed by whichever module uses it
 * — so anything it injects has to be visible from all of them.
 */
@Global()
@Module({
  providers: [ModuleAccessService],
  exports: [ModuleAccessService],
})
export class CommonModule {}
