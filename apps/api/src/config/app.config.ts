import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  appUrl: process.env.APP_URL ?? 'http://localhost:3000',
  apiUrl: process.env.API_URL ?? 'http://localhost:4000',
  cookieDomain: process.env.COOKIE_DOMAIN ?? '',

  // Auth
  jwtPrivateKey: process.env.JWT_PRIVATE_KEY ?? '',
  jwtPublicKey: process.env.JWT_PUBLIC_KEY ?? '',
  accessTokenTtl: parseInt(process.env.ACCESS_TOKEN_TTL ?? '900', 10),
  refreshTokenTtl: parseInt(process.env.REFRESH_TOKEN_TTL ?? '2592000', 10),
  deviceTokenTtl: parseInt(process.env.DEVICE_TOKEN_TTL ?? '3600', 10),
  magicLinkTtl: parseInt(process.env.MAGIC_LINK_TTL ?? '900', 10),

  // Mail
  mailTransport: process.env.MAIL_TRANSPORT ?? 'smtp',
  emailFrom: process.env.EMAIL_FROM ?? 'noreply@patrolkit.io',
  smtpHost: process.env.SMTP_HOST ?? 'localhost',
  smtpPort: parseInt(process.env.SMTP_PORT ?? '1025', 10),

  // AWS
  awsRegion: process.env.AWS_REGION ?? 'us-east-2',
  sesRegion: process.env.SES_REGION ?? 'us-east-2',

  // Seed
  seedSuperAdminEmail: process.env.SEED_SUPERADMIN_EMAIL ?? '',
}));
