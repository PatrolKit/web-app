# syntax=docker/dockerfile:1
# ─── Stage 1: Install all workspace dependencies ─────────────────────────────
FROM node:20-alpine AS deps
RUN npm install -g pnpm@11 && \
    apk add --no-cache openssl python3 make g++
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml pnpm.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# ─── Stage 2: Build web SPA ───────────────────────────────────────────────────
FROM deps AS web-build
COPY apps/web/ apps/web/
RUN pnpm --filter web build

# ─── Stage 3: Build NestJS API ────────────────────────────────────────────────
FROM deps AS api-build
COPY apps/api/ apps/api/
RUN pnpm --filter api build && \
    pnpm --filter api prisma:generate

# ─── Stage 4: Lean production image ──────────────────────────────────────────
FROM node:20-alpine AS production
RUN apk add --no-cache openssl
WORKDIR /app

# API compiled output
COPY --from=api-build /app/apps/api/dist ./dist
# API node_modules (Prisma client, runtime deps)
COPY --from=api-build /app/apps/api/node_modules ./node_modules
# Prisma schema + migrations + seed script
COPY --from=api-build /app/apps/api/prisma ./prisma
# Web SPA build served as static files at /web/dist
COPY --from=web-build /app/apps/web/dist ./web/dist
# Entrypoint script
COPY apps/api/entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 4000
ENTRYPOINT ["./entrypoint.sh"]
