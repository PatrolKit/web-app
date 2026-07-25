#!/usr/bin/env node
/**
 * scripts/dev-setup.mjs — Idempotent local dev bootstrap.
 *
 * Run once (or any time) from the server/ directory:
 *   node scripts/dev-setup.mjs
 *
 * What it does (skips steps already done):
 *   1. Checks Docker is running
 *   2. Starts MySQL + Mailpit if not already up
 *   3. Waits for MySQL to be healthy
 *   4. Copies .env.example → apps/api/.env if not present
 *   5. Generates JWT keys into apps/api/.env if still placeholder
 *   6. Installs pnpm dependencies if needed
 *   7. Runs Prisma migrations (deploy-safe, idempotent)
 *   8. Runs the idempotent seed
 *   9. Prints "Ready" with URLs
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateKeyPairSync } from 'crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(ROOT, 'apps', 'api', '.env');
const ENV_EXAMPLE = join(ROOT, '.env.example');

function run(cmd, opts = {}) {
  const result = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: ROOT, ...opts });
  if (result.status !== 0) {
    console.error(`\n✗ Command failed: ${cmd}`);
    process.exit(result.status ?? 1);
  }
}

function runSilent(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, stdio: 'pipe', cwd: ROOT, ...opts });
}

function step(label) {
  console.log(`\n▶ ${label}`);
}

// ─── 1. Docker check ────────────────────────────────────────────────────────
step('Checking Docker daemon');
const dockerInfo = runSilent('docker info');
if (dockerInfo.status !== 0) {
  console.error('✗ Docker is not running. Open Docker Desktop and retry.');
  process.exit(1);
}
console.log('  ✓ Docker running');

// ─── 2. Start compose services ───────────────────────────────────────────────
step('Starting MySQL + Mailpit (docker compose)');
const psResult = runSilent('docker compose ps --format json');
const runningServices = psResult.stdout?.toString() ?? '';
const mysqlUp = runningServices.includes('patrolkit-mysql') && runningServices.includes('"Running"');
const mailpitUp = runningServices.includes('patrolkit-mailpit') && runningServices.includes('"Running"');

if (mysqlUp && mailpitUp) {
  console.log('  ✓ Already running');
} else {
  run('docker compose up -d');
}

// ─── 3. Wait for MySQL health ────────────────────────────────────────────────
step('Waiting for MySQL to be healthy');
let healthy = false;
for (let i = 0; i < 30; i++) {
  const r = runSilent(
    "docker inspect --format '{{.State.Health.Status}}' patrolkit-mysql",
  );
  if (r.stdout?.toString().trim() === 'healthy') {
    healthy = true;
    break;
  }
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 2000));
}
if (!healthy) {
  console.error('\n✗ MySQL did not become healthy in time. Check: docker compose logs mysql');
  process.exit(1);
}
console.log('\n  ✓ MySQL healthy');

// ─── 4. Copy .env ────────────────────────────────────────────────────────────
step('Checking apps/api/.env');
if (!existsSync(ENV_FILE)) {
  copyFileSync(ENV_EXAMPLE, ENV_FILE);
  console.log('  ✓ Created apps/api/.env from .env.example');
} else {
  console.log('  ✓ Already exists');
}

// ─── 5. Generate JWT keys if still placeholder ───────────────────────────────
step('Checking JWT keys in apps/api/.env');
let envContent = readFileSync(ENV_FILE, 'utf8');
if (envContent.includes('REPLACE_WITH_BASE64_ED25519_PRIVATE_KEY_PEM')) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const privB64 = Buffer.from(privateKey).toString('base64');
  const pubB64 = Buffer.from(publicKey).toString('base64');
  envContent = envContent
    .replace('REPLACE_WITH_BASE64_ED25519_PRIVATE_KEY_PEM', privB64)
    .replace('REPLACE_WITH_BASE64_ED25519_PUBLIC_KEY_PEM', pubB64);
  writeFileSync(ENV_FILE, envContent);
  console.log('  ✓ Generated fresh Ed25519 key pair');
} else {
  console.log('  ✓ Keys already set');
}

// ─── 6. Install dependencies ─────────────────────────────────────────────────
step('Installing dependencies (pnpm install)');
const nodeModulesExist = existsSync(join(ROOT, 'node_modules'));
if (!nodeModulesExist) {
  run('pnpm install');
} else {
  // Still run to pick up any new packages, pnpm is fast when up-to-date
  run('pnpm install');
}
console.log('  ✓ Dependencies ready');

// ─── 7. Prisma migrations ────────────────────────────────────────────────────
step('Running Prisma migrations');
run('pnpm --filter api db:deploy', {
  env: { ...process.env, DATABASE_URL: getDbUrl(envContent) },
});
console.log('  ✓ Migrations applied');

// ─── 8. Seed ─────────────────────────────────────────────────────────────────
step('Running idempotent seed');
run('pnpm --filter api db:seed');
console.log('  ✓ Seed complete');

// ─── 9. Done ─────────────────────────────────────────────────────────────────
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PatrolKit local dev is ready!

  Start:   pnpm dev
  API:     http://localhost:4000/healthz
  Web:     http://localhost:3000
  Mailpit: http://localhost:8025

  Sign in with the email in SEED_SUPERADMIN_EMAIL
  (default: admin@example.com — check apps/api/.env)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getDbUrl(envText) {
  const match = envText.match(/^DATABASE_URL=(.+)$/m);
  return match ? match[1].trim() : 'mysql://patrolkit:patrolkit@localhost:3306/patrolkit';
}
