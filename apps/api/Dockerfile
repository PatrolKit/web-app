# ─── Stage 1: Install all workspace dependencies ─────────────────────────────
FROM node:22-alpine AS deps
# pnpm v9 is used in Docker: v11 removed dangerously-allow-all-builds and the replacement
# (onlyBuiltDependencies in pnpm-workspace.yaml) does not work with a lockfile that
# pre-dates the approval mechanism. Both versions read lockfileVersion 9.0.
RUN npm install -g pnpm@9 && \
    apk add --no-cache openssl python3 make g++
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml pnpm.json .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# shamefully-hoist: puts all packages in root node_modules so TypeScript/Node can
# find them without following pnpm's symlinks (which break across Alpine containers)
RUN pnpm install --frozen-lockfile --shamefully-hoist

# ─── Stage 2: Build web SPA ───────────────────────────────────────────────────
FROM deps AS web-build
COPY apps/web/ apps/web/
RUN pnpm --filter web build

# ─── Stage 3: Build NestJS API + create production-ready deploy bundle ────────
FROM deps AS api-build
COPY apps/api/ apps/api/
RUN pnpm --filter api prisma:generate && \
    pnpm --filter api build && \
    # compile seed.ts to JS so the production image needs no ts-node
    node_modules/.bin/tsc --outDir /seed-dist --rootDir apps/api/prisma \
      --skipLibCheck --esModuleInterop \
      --module commonjs --target ES2022 --moduleResolution node \
      apps/api/prisma/seed.ts && \
    pnpm deploy --filter api --prod /deploy

# ─── Stage 4: Lean production image ──────────────────────────────────────────
FROM node:22-alpine AS production
RUN apk add --no-cache openssl
WORKDIR /app

# pnpm deploy resolves all symlinks — real files, no pnpm store required
COPY --from=api-build /deploy/node_modules ./node_modules
# Prisma generated client lives in the shamefully-hoisted root node_modules
COPY --from=api-build /app/apps/api/node_modules/.prisma ./node_modules/.prisma
# API compiled output
COPY --from=api-build /app/apps/api/dist ./dist
# Prisma schema + migrations; seed is now pre-compiled JS
COPY --from=api-build /app/apps/api/prisma ./prisma
COPY --from=api-build /seed-dist/seed.js ./prisma/seed.js
# Web SPA build served as static files at /web/dist
COPY --from=web-build /app/apps/web/dist ./web/dist
# Entrypoint script
COPY apps/api/entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 4000
ENTRYPOINT ["./entrypoint.sh"]
