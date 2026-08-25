import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ZodValidationPipe } from 'nestjs-zod';
import { join } from 'path';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { PermissionsModule } from './permissions/permissions.module';
import { MeModule } from './me/me.module';
import { OrgsModule } from './orgs/orgs.module';
import { MembersModule } from './members/members.module';
import { PlatformModule } from './platform/platform.module';
import { OrgModulesModule } from './modules/modules.module';
import { DevicesModule } from './devices/devices.module';
import { AuditModule } from './common/audit/audit.module';
import { SkiSwapModule } from './ski-swap/ski-swap.module';
import { TimeClockModule } from './time-clock/time-clock.module';
import { SmsModule } from './sms/sms.module';
import appConfig from './config/app.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      // In test mode, process.env is already set by the test setup (e.g. Testcontainers URL).
      // Ignore the .env file so it doesn't overwrite the container DATABASE_URL.
      ignoreEnvFile: process.env['NODE_ENV'] === 'test',
      envFilePath: ['.env'],
    }),
    // Serve the pre-built web SPA (production only — skipped if dist not present)
    ...(existsSync(join(process.cwd(), 'web', 'dist'))
      ? [ServeStaticModule.forRoot({
          rootPath: join(process.cwd(), 'web', 'dist'),
          exclude: ['/api/v1/(.*)', '/healthz', '/readyz'],
          serveStaticOptions: { index: 'landing.html' },
        })]
      : []),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env['LOG_LEVEL'] ?? 'info',
        genReqId: (req) => req.headers['x-request-id'] ?? uuidv4(),
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
          remove: true,
        },
      },
    }),
    PrismaModule,
    MailModule,
    SmsModule,
    AuthModule,
    PermissionsModule,
    MeModule,
    OrgsModule,
    MembersModule,
    PlatformModule,
    OrgModulesModule,
    DevicesModule,
    AuditModule,
    SkiSwapModule,
    TimeClockModule,
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    HealthModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
