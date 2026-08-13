#!/bin/sh
# PatrolKit API entrypoint — runs on every container start.
# Migrations + seed are idempotent so it is safe to run on every boot.
set -e

# App Runner injects DATABASE_URL as the raw JSON blob from Secrets Manager.
# A single Node call parses it and writes the connection URL to a temp file.
if echo "$DATABASE_URL" | grep -q '"host"'; then
  DATABASE_URL=$(node -e "
    const s = JSON.parse(process.env.DATABASE_URL);
    const pass = encodeURIComponent(s.password);
    process.stdout.write('mysql://' + s.username + ':' + pass + '@' + s.host + ':' + s.port + '/' + s.dbname);
  ")
  export DATABASE_URL
  echo "[entrypoint] DATABASE_URL constructed from secret JSON"
fi

echo "[entrypoint] Running Prisma migrations..."
node_modules/.bin/prisma migrate deploy

echo "[entrypoint] Running idempotent seed..."
node prisma/seed.js

echo "[entrypoint] Starting server..."
exec node dist/src/main.js
