import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  appUrl: process.env.APP_URL ?? 'http://localhost:3000',
  apiUrl: process.env.API_URL ?? 'http://localhost:4000',
  cookieDomain: process.env.COOKIE_DOMAIN ?? '',
  /// Where sellers land: the skiswap.* host, which is a different origin from
  /// the staff app. Sign-in links have to be issued against the origin the
  /// seller is actually on, or the link drops them into the staff app.
  sellerSiteUrl: process.env.SELLER_SITE_URL ?? 'http://localhost:3000',

  // Auth
  jwtPrivateKey: process.env.JWT_PRIVATE_KEY ?? '',
  jwtPublicKey: process.env.JWT_PUBLIC_KEY ?? '',
  accessTokenTtl: parseInt(process.env.ACCESS_TOKEN_TTL ?? '900', 10),
  refreshTokenTtl: parseInt(process.env.REFRESH_TOKEN_TTL ?? '2592000', 10),
  deviceTokenTtl: parseInt(process.env.DEVICE_TOKEN_TTL ?? '3600', 10),

  /// Master kill switch for ALL outbound email and SMS. Fail-closed: nothing is
  /// delivered unless this is explicitly set to 'on'. Must be turned on for
  /// production. See docs/plan/10_user consolidation — outbound sends stay off
  /// for the duration of the consolidation work.
  outboundNotifications: (process.env.OUTBOUND_NOTIFICATIONS ?? 'off') === 'on',

  // Mail
  mailTransport: process.env.MAIL_TRANSPORT ?? 'smtp',
  emailFrom: process.env.EMAIL_FROM ?? 'noreply@patrolkit.io',
  smtpHost: process.env.SMTP_HOST ?? 'localhost',
  smtpPort: parseInt(process.env.SMTP_PORT ?? '1025', 10),

  // AWS
  awsRegion: process.env.AWS_REGION ?? 'us-east-2',
  sesRegion: process.env.SES_REGION ?? 'us-east-2',
  snsOriginationNumber: process.env.AWS_SNS_ORIGINATION_NUMBER ?? '',

  // Seed
  seedSuperAdminEmail: process.env.SEED_SUPERADMIN_EMAIL ?? '',

  // Ski Swap
  squareEncryptionKey: process.env.SQUARE_ENCRYPTION_KEY ?? '',
  photoBucket: process.env.PHOTO_BUCKET ?? '',
  /** Private. Downloads are presigned per request; nothing is public. */
  deviceImageBucket: process.env.DEVICE_IMAGE_BUCKET ?? 'patrolkit-images',
  photoBaseUrl: process.env.PHOTO_BASE_URL ?? '',
}));
