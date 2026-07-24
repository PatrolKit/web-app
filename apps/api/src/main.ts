import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'readyz'],
  });

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
}

bootstrap();
