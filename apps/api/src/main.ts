import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import type { IncomingMessage } from 'http';
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
  //
  // PayPal's webhook signature is computed over the delivered bytes, so the
  // parsed object cannot be re-serialised to check it — a space or an escaped
  // character is enough to fail. The raw buffer is kept for that one path and
  // nowhere else: holding a second copy of every request body to serve one
  // route would be a waste, and request bodies are the last thing worth
  // duplicating in memory.
  app.use(json({
    limit: '1mb',
    verify: (req: IncomingMessage & { rawBody?: Buffer }, _res, buf) => {
      if (req.url?.includes('/webhooks/paypal/')) req.rawBody = Buffer.from(buf);
    },
  }));
  app.use(urlencoded({ limit: '1mb', extended: true }));

  // Health probes sit outside the version prefix. Their callers are
  // infrastructure — a load balancer, an uptime monitor, the deploy script —
  // and none of them should have to know the API is on v1, or have their check
  // silently move out from under them when it is on v2.
  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'readyz'],
  });

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
}

bootstrap();
