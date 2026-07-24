/**
 * Integration test helpers — shared test setup using Testcontainers MySQL.
 *
 * All integration test files import from this module to share the same container.
 */
import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { execSync } from 'child_process';
import { join } from 'path';
import * as supertest from 'supertest';
import { AppModule } from '../../src/app.module';

let container: StartedMySqlContainer;
let app: INestApplication;
let _request: ReturnType<typeof supertest.agent>;

export async function setupIntegrationSuite(): Promise<void> {
  container = await new MySqlContainer('mysql:8.0')
    .withDatabase('patrolkit_test')
    .withUsername('test')
    .withUserPassword('testpass')
    .withRootPassword('rootpass')
    .start();

  const dbUrl = container.getConnectionUri();
  process.env['DATABASE_URL'] = dbUrl;
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'error';       // suppress pino request logs in tests
  process.env['SEED_SUPERADMIN_EMAIL'] = 'admin@test.patrolkit.io';

  // Run migrations
  execSync('npx prisma migrate deploy', {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'inherit',
  });

  // Run seed
  execSync('npx ts-node -r tsconfig-paths/register prisma/seed.ts', {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: 'test' },
    stdio: 'inherit',
  });

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleFixture.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  _request = supertest.agent(app.getHttpServer());
}

export async function teardownIntegrationSuite(): Promise<void> {
  await app?.close();
  await container?.stop();
}

export function request() {
  return _request;
}

export function getApp() {
  return app;
}
