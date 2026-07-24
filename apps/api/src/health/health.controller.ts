import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }

  @Get('readyz')
  readyz() {
    // DB check will be wired in P1-T2 (PrismaService)
    return { status: 'ok' };
  }
}
