import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  // Derive the S3 hostname from PHOTO_BASE_URL so img-src stays in sync with config.
  const photoBaseUrl = process.env.PHOTO_BASE_URL ?? '';
  const photoHost = photoBaseUrl ? new URL(photoBaseUrl).host : null;

  // Allow landing page CDN resources (Tailwind CDN + Google Fonts)
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com'],
        scriptSrcAttr: ["'unsafe-inline'", "'unsafe-hashes'"],
        styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
        fontSrc: ["'self'", 'https:', 'data:'],
        // `blob:` is the check-in photo preview. A seller's picture is shown
        // back to them from an object URL before it is uploaded, and without
        // this the browser drops it silently — the preview rendered as an empty
        // box, on the deployed site only, since a dev server sends no policy.
        // Object URLs are same-origin and minted by the page itself, so this
        // grants no reach the page did not already have.
        imgSrc: ["'self'", 'data:', 'blob:', ...(photoHost ? [`https://${photoHost}`] : [])],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  }));
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
