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
- **Mailpit Web UI** → http://localhost:8025

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

- **API** → http://localhost:4000 (`GET /api/v1/healthz`, `GET /readyz`)
- **Web** → http://localhost:3000 (Vite dev server, proxies `/api` → API)
- **Magic-link emails** → http://localhost:8025

## Workspace scripts

| Command | Description |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm dev` | Start API + web in parallel (watch mode) |
| `pnpm build` | Production build (all apps) |
| `pnpm lint` | Lint all apps |
| `pnpm test` | Run unit tests |
| `pnpm db:migrate` | Run Prisma migrations (dev) |
| `pnpm db:seed` | Run the idempotent seed |
| `pnpm release` | Build, sync, and restart the app on the production server |

## Production deploy runbook

### Prerequisites

- SSH key at `~/.ssh/patrolkit.pem` with access to `ec2-user@patrolkit.io`
- `.env` configured on the server at `/home/ec2-user/patrolkit/.env`

### First-time server setup

1. SSH into the server and install Node.js, pnpm, and pm2.
2. Create `/home/ec2-user/patrolkit/.env` with all required variables (see `.env.example`).
3. Generate JWT keys and add them to the server's `.env`:

```bash
node scripts/gen-keys.mjs   # prints JWT_PRIVATE_KEY and JWT_PUBLIC_KEY
```

4. Set `SEED_SUPERADMIN_EMAIL` in the server's `.env`. The super admin logs in via magic link at `https://patrolkit.io/auth/login`.

### Deploy

```bash
pnpm release
```

This script:
1. Builds the API and web (`dist/` + `web/dist/`)
2. rsyncs compiled output and Prisma files to the server
3. Runs `prisma migrate deploy`
4. Restarts the app via pm2

### Verify

1. Navigate to `https://patrolkit.io`
2. Enter the `SEED_SUPERADMIN_EMAIL` address and check for the magic-link email
3. Confirm `https://patrolkit.io/api/v1/healthz` returns `200`

### Rollback

Re-deploy from a previous git revision:

```bash
git checkout <sha>
pnpm release
```

## Project structure

```
server/
├─ apps/
│  ├─ api/           # NestJS API (also serves the built web app in production)
│  └─ web/           # React + Vite SPA
├─ docker/
│  └─ docker-compose.yml   # MySQL 8 + Mailpit for local dev
├─ docs/plan/        # Implementation plan + task breakdown
├─ scripts/          # Build and deploy scripts
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
| Deployment | EC2 (rsync + SSH + pm2) |

See [`docs/plan/IMPLEMENTATION_PLAN.md`](docs/plan/IMPLEMENTATION_PLAN.md) for the full spec.
