#!/usr/bin/env node
// Deploy PatrolKit to EC2 via rsync + SSH.
// Usage: node scripts/release.mjs
// Prerequisites: SSH key at ~/.ssh/patrolkit.pem, server set up per RESET_PLAN.md

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

const SERVER = 'ec2-user@patrolkit.io';
const KEY = `${process.env.HOME}/.ssh/patrolkit.pem`;
const SSH = `ssh -i ${KEY} -o StrictHostKeyChecking=no`;
// The app lives in /opt/patrolkit and runs as the unprivileged `patrolkit` user
// under systemd (scripts/server/). Files are the deploy user's, readable by the
// patrolkit group. Its directories are setgid, so what's created in them takes
// the group. rsync copies no owner, group or permissions from the Mac (copying
// a directory's mode clears its setgid bit, and everything below it loses the
// group), and writes under umask 027: the group reads, nobody else does.
// Settings live in /etc/patrolkit/patrolkit.env, root's, readable by the group.
const APP = '/opt/patrolkit';
const ENV_FILE = '/etc/patrolkit/patrolkit.env';
const RSYNC = `rsync -rltz --rsync-path="umask 027 && rsync" -e "ssh -i ${KEY} -o StrictHostKeyChecking=no"`;
/** A command in the app's directory as `patrolkit`, with the app's settings. */
const asApp = (cmd) =>
  ssh(`sudo systemd-run --quiet --wait --pipe --collect --uid=patrolkit --gid=patrolkit -p EnvironmentFile=${ENV_FILE} -p WorkingDirectory=${APP} ${cmd}`);

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
/** Runs a local command for its output rather than streaming it. */
const count = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const ssh = (cmd) => run(`${SSH} ${SERVER} "${cmd}"`);
/** Runs a remote command and returns its stdout instead of streaming it. */
const sshCapture = (cmd) =>
  execSync(`${SSH} ${SERVER} "${cmd}"`, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  }).trim();

// 1. Build API and web
//
// `tsc` is incremental, and a stale tsbuildinfo makes it conclude the output is
// already up to date — so `nest build` prints nothing, exits 0, and emits no
// JavaScript whatever. This is not hypothetical: it took the site down. Step 2
// rsyncs with --delete, so an empty dist replaced a working one and pm2
// restarted into `Cannot find module './app.module'`.
//
// The build info normally lives inside the outDir and goes with it, but a stray
// copy at the repo root — left over from the July scaffold — poisons the build
// just as well, and the old `rm` here named a third path that never existed.
// So: delete every one of them wherever it sits, and never trust the exit code
// alone. A build that emits nothing has to fail here, not on the server.
console.log('Building...');
run("find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete");
run('rm -rf apps/api/dist');
run('pnpm --filter api build');

const emitted = Number(count("find apps/api/dist/src -name '*.js' | wc -l"));
const sources = Number(count("find apps/api/src -name '*.ts' -not -name '*.spec.ts' | wc -l"));
if (!existsSync('apps/api/dist/src/app.module.js') || emitted < sources * 0.9) {
  console.error(
    `\n  FAILED: the API build produced ${emitted} files from ${sources} sources.\n` +
    '  `nest build` exits 0 when an incremental build emits nothing, so this is\n' +
    '  caught by counting rather than by its status. Nothing has been sent.\n' +
    "  Check for a stale tsbuildinfo: find . -name '*.tsbuildinfo' -not -path '*/node_modules/*'\n" +
    '  Check also that no dev server is running: `nest start --watch` writes to\n' +
    '  the same dist, and two compilers on one directory short the emit.\n',
  );
  process.exit(1);
}
run('pnpm --filter web build', {
  env: { ...process.env, VITE_SELLER_SITE_URL: process.env.VITE_SELLER_SITE_URL ?? 'https://skiswap.patrolkit.io' },
});

// 2. Sync compiled output to server
console.log('Syncing to server...');
run(`${RSYNC} --delete apps/api/dist/ ${SERVER}:${APP}/dist/`);

// 3. Sync prisma migrations, the web SPA, and the API's package.json (for the record)
// --delete matters here: without it, migration folders removed locally survive
// on the server and get replayed, which is how a squashed history collides with
// its own baseline. Migrations were only ever added before, so this went unnoticed.
run(`${RSYNC} --delete apps/api/prisma/ ${SERVER}:${APP}/prisma/`);
run(`${RSYNC} --delete apps/web/dist/ ${SERVER}:${APP}/web/dist/`);
run(`${RSYNC} apps/api/package.json ${SERVER}:${APP}/package.json`);

// 4. The API's production modules: exactly the lockfile's, built for the
// server's platform (Plan 54 step 1). Never `npm install` on the server: that
// resolved package.json's ranges afresh on every deploy, into versions nobody
// had tested, and ran every package's install scripts.
//
// Sent only when they changed. They go next to the live ones (unchanged files
// hard-linked, so only what changed crosses the network), then swap in; the
// previous set stays as node_modules.prev, to swap back by hand if need be.
run('node scripts/build-api-modules.mjs');
const builtKey = readFileSync('.deploy/api/node_modules/.patrolkit-key', 'utf8');
const serverKey = sshCapture(`cat ${APP}/node_modules/.patrolkit-key 2>/dev/null || true`);
if (serverKey === builtKey) {
  console.log(`Server modules already current (${builtKey}).`);
} else {
  console.log(`Sending the API's modules (${serverKey || 'npm-installed'} → ${builtKey})...`);
  // --checksum: a rebuild has new file times, so compare contents to reuse what's unchanged.
  run(`${RSYNC} --checksum --delete --link-dest=${APP}/node_modules .deploy/api/node_modules/ ${SERVER}:${APP}/node_modules.next/`);
  ssh(`cd ${APP} && rm -rf node_modules.prev && mv node_modules node_modules.prev && mv node_modules.next node_modules`);
}

// 5. Regenerate the Prisma client, run any pending migrations, then seed.
// Generate has to come first: a deploy that adds models leaves the server's
// client stale, and the seed is typechecked against it.
console.log('Regenerating Prisma client...');
// Generate writes into node_modules, which is the deploy user's; umask keeps it from others.
ssh(`cd ${APP} && umask 027 && node_modules/.bin/prisma generate`);
// Then make sure: everything the group's, readable by it, by nobody else. A file
// the app can't read surfaces as a crash on its first lazy require, long after.
ssh(`sudo chgrp -R patrolkit ${APP} && sudo chmod -R g+rX,g-w,o-rwx ${APP} && sudo find ${APP} -type d ! -perm -g+s -exec chmod g+s {} +`);
console.log('Running migrations...');
asApp(`/usr/bin/node ${APP}/node_modules/prisma/build/index.js migrate deploy`);
console.log('Seeding database...');
asApp(`/usr/bin/node ${APP}/node_modules/ts-node/dist/bin.js --project prisma/tsconfig.seed.json prisma/seed.ts`);

// 6a. Warn if the seller-site origin is unset.
// It falls back to localhost, which is right for development and silently wrong
// here: every check-in sign-in link and every receipt QR would point at a
// machine the seller does not have. The symptom is a dead link days later.
const sellerSite = sshCapture(
  `sudo grep -E '^SELLER_SITE_URL=' ${ENV_FILE} || true`,
);
if (!sellerSite) {
  console.warn(
    '\n  WARNING: SELLER_SITE_URL is not set on the server.\n' +
    '  Check-in sign-in links and receipt QR codes will point at localhost.\n' +
    '  Set SELLER_SITE_URL=https://skiswap.patrolkit.io in\n' +
    `  ${ENV_FILE} (sudoedit) and restart.\n`,
  );
}

// 6. Warn if outbound notifications are switched off on the server.
// The switch is fail-closed, so an unset variable means no email or SMS is
// ever delivered — and the symptom is silence, not an error. Surfacing it
// here is cheaper than discovering it when an invite never arrives.
const outbound = sshCapture(
  `sudo grep -E '^OUTBOUND_NOTIFICATIONS=' ${ENV_FILE} || true`,
);
if (outbound !== 'OUTBOUND_NOTIFICATIONS=on') {
  console.warn(
    `\n  WARNING: outbound notifications are OFF on the server (${outbound || 'not set'}).\n` +
    '  No email or SMS will be delivered. Set OUTBOUND_NOTIFICATIONS=on in\n' +
    `  ${ENV_FILE} (sudoedit) and restart to enable delivery.\n`,
  );
}

// 7. Restart the service. systemd stops the old process, starts the new one
// as `patrolkit`, and restarts it if it dies.
console.log('Restarting app...');
ssh('sudo systemctl restart patrolkit');

// 8. Prove the app actually came back.
//
// A restart that fails leaves the site down, and the script would otherwise
// print "Done." over a 502. Poll until it answers, and fail loudly if it never does.
//
// `/readyz`, not `/healthz`: this runs immediately after a migration, and the
// one failure worth catching here is an app that answers while its database
// does not. A liveness probe would report that as a clean deploy.
console.log('Waiting for the app to come back...');
let healthy = false;
for (let attempt = 1; attempt <= 15; attempt++) {
  const code = execSync(
    'curl -s -o /dev/null -w "%{http_code}" https://patrolkit.io/readyz || true',
    { encoding: 'utf8' },
  ).trim();
  if (code === '200') { healthy = true; break; }
  execSync('sleep 2');
}

if (!healthy) {
  console.error(
    '\n  FAILED: the app did not come back after the restart.\n' +
    '  It may be stopped (failing to start), or up but unable to reach the\n' +
    '  database — /readyz covers both.\n' +
    '  Check: ssh ... "systemctl status patrolkit; journalctl -u patrolkit -n 50 --no-pager"\n',
  );
  process.exit(1);
}

console.log('\nDone. https://patrolkit.io/readyz');
