# PatrolKit — Server

Multi-org foundation: magic-link auth, per-org permissions, pluggable modules, and device provisioning.

## Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 9 (`npm install -g pnpm`)
- **Docker Desktop** (for local MySQL + Mailpit)

## Quick start (local dev)

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start local services (MySQL + Mailpit)

```bash
docker compose up -d
```

- **MySQL** on `localhost:3306` — credentials: `patrolkit / patrolkit`
- **Mailpit SMTP** on `localhost:1025`
- **Mailpit Web UI** → http://localhost:8025 (view captured magic-link emails here)

### 3. Configure environment

```bash
cp .env.example apps/api/.env
# Edit apps/api/.env if needed (defaults work with docker-compose)
```

### 4. Run migrations + seed

```bash
pnpm db:migrate   # prisma migrate dev
pnpm db:seed      # upsert permissions, modules, super-admin
```

### 5. Start the app

```bash
pnpm dev
```

- **API** → http://localhost:4000  (`GET /healthz`, `GET /readyz`)
- **Web** → http://localhost:3000 (Vite dev server, proxies `/api` → API)
- **Magic-link emails** → http://localhost:8025

## Workspace scripts

| Command | Description |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm dev` | Start API + web in parallel (watch mode) |
| `pnpm build` | Production build (all apps) |
| `pnpm lint` | Lint all apps |
| `pnpm test` | Run all tests |
| `pnpm db:migrate` | Run Prisma migrations (dev) |
| `pnpm db:seed` | Run the idempotent seed |

## Project structure

```
server/
├─ apps/
│  ├─ api/           # NestJS API (also serves the built web app in production)
│  └─ web/           # React + Vite SPA
├─ infra/            # AWS CDK stacks (added in Phase 8)
├─ docker/
│  └─ docker-compose.yml   # MySQL 8 + Mailpit for local dev
├─ docs/plan/        # Implementation plan + task breakdown
├─ .env.example      # All required environment variables with placeholder values
└─ pnpm-workspace.yaml
```

## Tech stack

| Layer | Technology |
|---|---|
| API | NestJS + TypeScript + Prisma (MySQL) |
| Auth | Magic link only (no passwords) · JWT EdDSA |
| Web | React + Vite + TypeScript + Tailwind + TanStack Query + React Router |
| Local email | Mailpit (SMTP capture) |
| Production email | Amazon SES |
| Deployment | AWS App Runner (CDK) |

See [`docs/plan/IMPLEMENTATION_PLAN.md`](docs/plan/IMPLEMENTATION_PLAN.md) for the full spec.
