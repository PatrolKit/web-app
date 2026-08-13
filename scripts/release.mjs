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

// 1. Build API and web
console.log('Building...');
run('pnpm --filter api build');
run('pnpm --filter web build');

// 2. Sync compiled output to server
console.log('Syncing to server...');
run(`rsync -az --delete -e "ssh -i ${KEY} -o StrictHostKeyChecking=no" \
  apps/api/dist/ \
  ${SERVER}:/home/ec2-user/patrolkit/dist/`);

// 3. Sync prisma migrations and web SPA
run(`rsync -az -e "ssh -i ${KEY} -o StrictHostKeyChecking=no" \
  apps/api/prisma/ \
  ${SERVER}:/home/ec2-user/patrolkit/prisma/`);
run(`rsync -az --delete -e "ssh -i ${KEY} -o StrictHostKeyChecking=no" \
  apps/web/dist/ \
  ${SERVER}:/home/ec2-user/patrolkit/web/dist/`);

// 4. Run any pending migrations
console.log('Running migrations...');
ssh('cd /home/ec2-user/patrolkit && node_modules/.bin/prisma migrate deploy');

// 5. Restart app — cd into app dir so process.cwd() resolves web/dist correctly
console.log('Restarting app...');
ssh('pm2 delete patrolkit 2>/dev/null; set -a && source /home/ec2-user/patrolkit/.env && set +a && cd /home/ec2-user/patrolkit && pm2 start dist/src/main.js --name patrolkit && pm2 save');

console.log('\nDone. https://patrolkit.io/healthz');
