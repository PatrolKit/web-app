import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import type { IncomingMessage } from 'http';
import { AppModule } from './app.module';
import { attributionMiddleware } from './common/limits/request-attribution';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  /*
   * Caddy sits in front of this on the same box, so every connection Node sees
   * comes from loopback. Without this line `req.ip` was Caddy's address for
   * every request in production — `::ffff:127.0.0.1`, the only value in the
   * logs — and the throttle, which keys on `req.ip`, was one bucket for the
   * whole site: a hundred requests a minute across every user and device
   * combined, and five sign-in requests a minute for everybody in the world.
   * One busy check-in table would have locked out the next.
   *
   * `'loopback'` rather than `true` or a hop count: trust the forwarding header
   * only when the connection itself came from this machine. If Node were ever
   * reachable directly, a client's own `X-Forwarded-For` would be ignored
   * rather than believed, so the fix cannot become a way to pick your own
   * bucket.
   */
  app.set('trust proxy', 'loopback');

  // Which org and swap each request is about, for the Server health page. First,
  // so that everything after it runs inside the request's own record.
  app.use(attributionMiddleware);

  // A pm2 restart sends a signal; without this Nest exits without running its
  // shutdown hooks, and the last minute of limit usage goes with it.
  app.enableShutdownHooks();

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
  // One route takes more: a station's iPad sends the pages it drew to print at
  // the bridge (iOS Plan 26), 37–57 KB each, and a long receipt is several.
  // Parsed here first, so the general parser below finds the body already read.
  app.use(/^\/api\/v1\/orgs\/[^/]+\/ski-swap\/stations\/[^/]+\/print$/, json({ limit: '3mb' }));
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
