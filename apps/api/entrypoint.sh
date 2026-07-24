#!/bin/sh
# PatrolKit API entrypoint — runs on every container start.
# Migrations + seed are idempotent so it is safe to run on every boot.
set -e

echo "[entrypoint] Running Prisma migrations..."
node node_modules/.bin/prisma migrate deploy

echo "[entrypoint] Running idempotent seed..."
node node_modules/.bin/ts-node \
    -r node_modules/tsconfig-paths/register \
    prisma/seed.ts

echo "[entrypoint] Starting server..."
exec node dist/main.js
