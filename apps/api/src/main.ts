import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  // Security headers — no CORS for browser (same origin)
  app.use(helmet());
  app.use(cookieParser());

  // Body size limits (CSV uploads handled separately by multer)
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ limit: '1mb', extended: true }));

  app.setGlobalPrefix('api/v1', {
    exclude: ['readyz'],
  });

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
}

bootstrap();
