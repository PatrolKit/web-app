#!/usr/bin/env node
// Deploy PatrolKit to EC2 via rsync + SSH.
// Usage: node scripts/release.mjs
// Prerequisites: SSH key at ~/.ssh/patrolkit.pem, server set up per RESET_PLAN.md

import { execSync } from 'child_process';

const SERVER = 'ec2-user@patrolkit.io';
const KEY = `${process.env.HOME}/.ssh/patrolkit.pem`;
const SSH = `ssh -i ${KEY} -o StrictHostKeyChecking=no`;

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const ssh = (cmd) => run(`${SSH} ${SERVER} "${cmd}"`);
/** Runs a remote command and returns its stdout instead of streaming it. */
const sshCapture = (cmd) =>
  execSync(`${SSH} ${SERVER} "${cmd}"`, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  }).trim();

// 1. Build API and web
console.log('Building...');
run('pnpm --filter api build');
run('pnpm --filter web build', {
  env: { ...process.env, VITE_SELLER_SITE_URL: process.env.VITE_SELLER_SITE_URL ?? 'https://skiswap.patrolkit.io' },
});

// 2. Sync compiled output to server
console.log('Syncing to server...');
run(`rsync -az --delete -e "ssh -i ${KEY} -o StrictHostKeyChecking=no" \
  apps/api/dist/ \
  ${SERVER}:/home/ec2-user/patrolkit/dist/`);

// 3. Sync prisma migrations, web SPA, and package.json (for npm install on server)
run(`rsync -az -e "ssh -i ${KEY} -o StrictHostKeyChecking=no" \
  apps/api/prisma/ \
  ${SERVER}:/home/ec2-user/patrolkit/prisma/`);
run(`rsync -az --delete -e "ssh -i ${KEY} -o StrictHostKeyChecking=no" \
  apps/web/dist/ \
  ${SERVER}:/home/ec2-user/patrolkit/web/dist/`);
run(`rsync -az -e "ssh -i ${KEY} -o StrictHostKeyChecking=no" \
  apps/api/package.json \
  ${SERVER}:/home/ec2-user/patrolkit/package.json`);

// 4. Install any new server-side dependencies, run migrations, regenerate Prisma client
console.log('Installing dependencies...');
ssh('cd /home/ec2-user/patrolkit && npm install --omit=dev 2>&1 | tail -3');

// 5. Regenerate the Prisma client, run any pending migrations, then seed.
// Generate has to come first: a deploy that adds models leaves the server's
// client stale, and the seed is typechecked against it.
console.log('Regenerating Prisma client...');
ssh('cd /home/ec2-user/patrolkit && node_modules/.bin/prisma generate');
console.log('Running migrations...');
ssh('cd /home/ec2-user/patrolkit && node_modules/.bin/prisma migrate deploy');
console.log('Seeding database...');
ssh('cd /home/ec2-user/patrolkit && node_modules/.bin/ts-node --project prisma/tsconfig.seed.json prisma/seed.ts');

// 6. Warn if outbound notifications are switched off on the server.
// The switch is fail-closed, so an unset variable means no email or SMS is
// ever delivered — and the symptom is silence, not an error. Surfacing it
// here is cheaper than discovering it when an invite never arrives.
const outbound = sshCapture(
  "grep -E '^OUTBOUND_NOTIFICATIONS=' /home/ec2-user/patrolkit/.env || true",
);
if (outbound !== 'OUTBOUND_NOTIFICATIONS=on') {
  console.warn(
    `\n  WARNING: outbound notifications are OFF on the server (${outbound || 'not set'}).\n` +
    '  No email or SMS will be delivered. Set OUTBOUND_NOTIFICATIONS=on in\n' +
    '  /home/ec2-user/patrolkit/.env and restart to enable delivery.\n',
  );
}

// 7. Restart app — cd into app dir so process.cwd() resolves web/dist correctly
console.log('Restarting app...');
ssh('pm2 delete patrolkit 2>/dev/null; set -a && source /home/ec2-user/patrolkit/.env && set +a && cd /home/ec2-user/patrolkit && pm2 start dist/src/main.js --name patrolkit && pm2 save');

console.log('\nDone. https://patrolkit.io/api/v1/healthz');
