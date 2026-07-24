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
| `pnpm test` | Run unit tests |
| `pnpm db:migrate` | Run Prisma migrations (dev) |
| `pnpm db:seed` | Run the idempotent seed |
| `pnpm image:build` | Build the combined API+web Docker image |
| `pnpm image:push` | Push image to ECR (requires AWS login) |
| `pnpm release` | Trigger App Runner deployment |
| `pnpm infra:synth` | Synthesise CDK stacks (no AWS needed) |
| `pnpm infra:deploy` | Deploy all CDK stacks to AWS |

## Production deploy runbook (P9-T4)

### Prerequisites

```bash
aws sso login --profile patrolkit    # IAM Identity Center login
cdk bootstrap aws://<ACCOUNT>/us-east-2   # one-time per account/region
```

### First deploy (infrastructure)

```bash
# 1. Deploy CDK stacks: Network → Data → Shared → Api
pnpm infra:deploy

# 2. Populate JWT keys in Secrets Manager (one-time)
node scripts/gen-keys.mjs            # prints JWT_PRIVATE_KEY and JWT_PUBLIC_KEY
# Then update the secret via AWS console or CLI:
# aws secretsmanager update-secret --secret-id patrolkit/jwt-keys \
#   --secret-string '{"JWT_PRIVATE_KEY":"...","JWT_PUBLIC_KEY":"..."}'
```

### Deploy the app (API + web in one image)

```bash
# 1. Build production image
pnpm build                # compile web + API
pnpm image:build          # docker build -t patrolkit:latest

# 2. Push to ECR
pnpm image:push           # tags + pushes patrolkit:<git-sha> and :latest

# 3. Trigger App Runner deployment
pnpm release              # aws apprunner start-deployment
```

On container start the entrypoint automatically runs:
- `prisma migrate deploy` — applies any pending migrations
- `ts-node prisma/seed.ts` — idempotent seed (permissions, super admin)
- `node dist/main.js` — starts the server

### Bootstrap super admin (first run)

The super admin email is driven by `SEED_SUPERADMIN_EMAIL` injected as an App Runner env var. Set it in the `patrolkit/jwt-keys` or as a plaintext env var in the App Runner service config, then deploy once. The super admin logs in via the normal magic-link flow at `https://patrolkit.io/auth/login`.

### Verify first login

1. Navigate to `https://patrolkit.io`
2. Enter the `SEED_SUPERADMIN_EMAIL` address
3. Check email for the magic link
4. Click → you should land in the Platform Admin screen

### Rollback

App Runner keeps the previous image revision. To roll back:

```bash
aws apprunner list-operations --service-arn <ARN>
aws apprunner start-deployment --service-arn <ARN>  # previous image still in ECR
# Or re-tag a previous sha and push, then run `pnpm release`
```

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
