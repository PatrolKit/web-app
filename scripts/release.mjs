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
//
// The API build is incremental, and its tsbuildinfo outlives `rm -rf dist` —
// which leaves a dist holding only whatever changed since. That is invisible
// locally (the running server is already loaded) and fatal here, because step 2
// rsyncs with --delete. Start from nothing.
console.log('Building...');
run('rm -rf apps/api/dist apps/api/tsconfig.tsbuildinfo');
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
// --delete matters here: without it, migration folders removed locally survive
// on the server and get replayed, which is how a squashed history collides with
// its own baseline. Migrations were only ever added before, so this went unnoticed.
run(`rsync -az --delete -e "ssh -i ${KEY} -o StrictHostKeyChecking=no" \
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

// 6a. Warn if the seller-site origin is unset.
// It falls back to localhost, which is right for development and silently wrong
// here: every check-in sign-in link and every receipt QR would point at a
// machine the seller does not have. The symptom is a dead link days later.
const sellerSite = sshCapture(
  "grep -E '^SELLER_SITE_URL=' /home/ec2-user/patrolkit/.env || true",
);
if (!sellerSite) {
  console.warn(
    '\n  WARNING: SELLER_SITE_URL is not set on the server.\n' +
    '  Check-in sign-in links and receipt QR codes will point at localhost.\n' +
    '  Set SELLER_SITE_URL=https://skiswap.patrolkit.io in\n' +
    '  /home/ec2-user/patrolkit/.env and restart.\n',
  );
}

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

// 8. Prove the app actually came back.
//
// Step 7 deletes the pm2 process before starting the new one, so anything that
// fails in between leaves the site down — and the script would otherwise print
// "Done." over a 502. Poll until it answers, and fail loudly if it never does.
console.log('Waiting for the app to come back...');
let healthy = false;
for (let attempt = 1; attempt <= 15; attempt++) {
  const code = execSync(
    'curl -s -o /dev/null -w "%{http_code}" https://patrolkit.io/api/v1/healthz || true',
    { encoding: 'utf8' },
  ).trim();
  if (code === '200') { healthy = true; break; }
  execSync('sleep 2');
}

if (!healthy) {
  console.error(
    '\n  FAILED: the app did not come back after the restart.\n' +
    '  It may be stopped entirely — step 7 deletes the pm2 process first.\n' +
    '  Check: ssh ... "pm2 list && pm2 logs patrolkit --lines 50 --nostream"\n',
  );
  process.exit(1);
}

console.log('\nDone. https://patrolkit.io/api/v1/healthz');
