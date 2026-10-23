#!/usr/bin/env node
// The API's production node_modules, built from pnpm-lock.yaml on the server's
// platform (Plan 54 step 1). Production used to `npm install` from package.json
// ranges on the server: versions nobody had tested, and every package's install
// scripts. This builds exactly the lockfile's tree, in a container matching the
// server, and only when the lockfile or the API's package.json changed.
//
//   node scripts/build-api-modules.mjs        → .deploy/api/node_modules
//
// Output: the directory to rsync, and its key (a hash of the inputs).

import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { basename, dirname } from 'path';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const OUT = '.deploy/api';
const IMAGE = 'patrolkit-api-modules:al2023-node22-pnpm11';
const SERVER_NODE = process.env.SERVER_NODE ?? '22';
const SERVER_DIR = '/opt/patrolkit';

const inputs = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'apps/api/package.json', 'scripts/api-modules/Dockerfile', 'scripts/build-api-modules.mjs'];
const key = createHash('sha256').update(inputs.map((f) => readFileSync(f)).join('\0')).digest('hex').slice(0, 16);
const stamp = `${OUT}/.key`;

if (existsSync(stamp) && readFileSync(stamp, 'utf8') === key && existsSync(`${OUT}/node_modules`)) {
  console.log(`API modules unchanged (${key}).`);
} else {
  console.log(`Building the API's production modules from the lockfile (${key})...`);
  run(`docker build --platform linux/amd64 -q -t ${IMAGE} scripts/api-modules`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  // The repo read-only, pnpm's store as a volume, and the output at the
  // server's own path, so the paths pnpm writes into .bin shims are the
  // server's. --frozen-lockfile: a lockfile that doesn't match package.json
  // fails here, not on the server. Only the API's slice of the lockfile is
  // installed and checked, so the web's private Font Awesome registry isn't
  // needed.
  run(
    `docker run --rm --platform linux/amd64 -v "$PWD":/src:ro -v "$PWD/${OUT}":${dirname(SERVER_DIR)} ` +
    `-v patrolkit-pnpm-store:/store ${IMAGE} ` +
    `pnpm --filter api deploy --prod --frozen-lockfile --config.inject-workspace-packages=true --config.store-dir=/store ${SERVER_DIR}`,
  );
  // Deploy copies the package's files too (sources, a local .env): keep only the modules.
  run(`mv ${OUT}/${basename(SERVER_DIR)}/node_modules ${OUT}/node_modules && rm -rf ${OUT}/${basename(SERVER_DIR)}`);
  // The key travels with the modules, so a deploy can tell what the server has.
  writeFileSync(`${OUT}/node_modules/.patrolkit-key`, key);
  // Prove it loads on the server's Node, on the server's platform: every native
  // module, and the Prisma client's engine for this OS. Only then is it ready.
  verify();
  writeFileSync(stamp, key);
}

console.log(`\nAPI modules ready: ${OUT}/node_modules (${key})`);

function verify() {
  run(
    `docker run --rm --platform linux/amd64 -v "$PWD/${OUT}":${SERVER_DIR}:ro -w ${SERVER_DIR} amazonlinux:2023 bash -c ` +
    `"dnf install -y -q nodejs${SERVER_NODE} >/dev/null && node -v && node -e '` +
    `for (const m of [\\"argon2\\", \\"sharp\\", \\"@napi-rs/canvas\\", \\"exceljs\\", \\"@nestjs/core\\", \\"@prisma/client\\"]) { require(m); console.log(\\"ok\\", m); }'"`,
  );
}
