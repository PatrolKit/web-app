# PatrolKit — Server

The PatrolKit API and web app: multi-organization patrol management. It covers members and permissions, the ski swap (check-in, tags and printing, Square sales, seller payouts), the time clock, and provisioned devices (check-in iPads, print and scanner bridges). Sign-in is passwordless.

## Layout

```
server/
├─ apps/
│  ├─ api/            # NestJS API; serves the built web app in production
│  │  ├─ prisma/      # schema, migrations, seed, taxonomy, indemnification lists
│  │  └─ scripts/     # smoke scripts and one-off tools
│  └─ web/            # React + Vite SPA (staff site at /app, seller site at /)
├─ docs/plan/         # one folder per feature: IMPLEMENTATION_PLAN.md, iPad handoffs
├─ scripts/           # dev-setup.mjs, release.mjs, gen-keys.mjs
├─ docker-compose.yml # MySQL 8 + Mailpit for local development
├─ .env.example       # every variable the API reads, with placeholders
└─ TESTING.md         # the seeded demo users and how to sign in locally
```

## Local development

**Needs:** Node.js 20 or later, pnpm 9 or later, and Docker Desktop.

```bash
node scripts/dev-setup.mjs
```

```bash
pnpm dev
```

`dev-setup.mjs` is safe to rerun. It:
1. starts MySQL and Mailpit;
2. copies `.env.example` to `apps/api/.env`;
3. generates JWT keys;
4. installs dependencies;
5. migrates and seeds the database.

Once `pnpm dev` is running:
- **Web:** http://localhost:3000. It proxies `/api` to the API.
- **API:** http://localhost:4000. `GET /healthz` checks the app; `GET /readyz` checks the app and its database.
- **Mailpit:** http://localhost:8025, for email when delivery is on.

**Signing in locally:** go to `/app/auth/login` with an email or phone number. Outbound mail and SMS are off by default, so the page shows the code itself. [`TESTING.md`](TESTING.md) lists the seeded demo users.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | API and web in watch mode |
| `pnpm build` | Builds every app |
| `pnpm lint` | Lints every app |
| `pnpm test` | Unit tests: Jest for the API, Vitest for the web |
| `pnpm db:migrate` | `prisma migrate dev` |
| `pnpm db:seed` | The seed: permissions, modules, the super admin, demo data in development |
| `pnpm release` | Deploys to production (below) |

## Smoke scripts

`apps/api/scripts/smoke-*.mjs` check a feature end to end against a running API and a real database. Each comment header says how to run it.

Every script works only in the test organization, `patrolkit-smoke`. It creates that org, and the empty `patrolkit-smoke-other` that a few scripts use to test what one org can't see of another. Each script clears out what it made on its last run before starting, and most remove it again when done.

Some run against stand-ins rather than the real services:
- **Square:** `PAYOUTS_STUB=1` with `SMOKE_CATALOG_FILE`, `SMOKE_INVENTORY_FILE` or `SMOKE_SALES_FILE`;
- **PayPal:** `PAYPAL_STUB_LOG`.

To smoke production, copy the script and `_fixture.mjs` to `/home/ec2-user/patrolkit/.smoke/` and run it there with the server's `.env` loaded (`set -a && . ./.env && set +a`).

## Production

- **Server:** one EC2 instance at `patrolkit.io`, with Caddy in front (`/etc/caddy/Caddyfile`). The app lives in `/home/ec2-user/patrolkit`, runs under pm2 as `patrolkit`, and reads `/home/ec2-user/patrolkit/.env`.
- **Data:** production holds real data, and there is no staging copy.
  - Migrations are additive only: new tables and nullable or defaulted columns, never a drop or a rewrite.
  - Never wipe or reset the database.
  - Test a change locally against a copy of the database before it ships.

### Access

SSH goes through an EC2 Instance Connect tunnel. It needs the key at `~/.ssh/patrolkit.pem`, a current `aws login`, and this entry in `~/.ssh/config`:

```
Host patrolkit.io
  HostName i-09990cdbf7eba8daa
  User ec2-user
  IdentityFile ~/.ssh/patrolkit.pem
  ProxyCommand aws ec2-instance-connect open-tunnel --instance-id i-09990cdbf7eba8daa --region us-east-2
```

### Deploy

```bash
pnpm release
```

The release:
1. builds the API and web, and fails if the API build emits nothing;
2. rsyncs `dist/`, `prisma/` and `web/dist/` to the server;
3. installs dependencies, regenerates the Prisma client, runs `prisma migrate deploy` and the seed;
4. restarts pm2;
5. waits for `https://patrolkit.io/readyz`.

It warns when `SELLER_SITE_URL` is unset, or when `OUTBOUND_NOTIFICATIONS` isn't `on`. With notifications off, no email or SMS is ever delivered.

**Rollback:** check out an earlier commit and run `pnpm release` again. Migrations aren't undone. Since they're additive, older code runs fine against the newer schema.

### First-time setup

1. Install Node.js, pnpm and pm2 on the instance.
2. Create the server's `.env` from `.env.example`. Use `node scripts/gen-keys.mjs` for `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY`.
3. Set `SEED_SUPERADMIN_EMAIL`, `OUTBOUND_NOTIFICATIONS=on` and `SELLER_SITE_URL=https://skiswap.patrolkit.io`.
4. Run `pnpm release`.
5. Sign in at `https://patrolkit.io/app/auth/login` with the super admin's email.

## Stack

| Concern | What it uses |
|---|---|
| API | NestJS, TypeScript, Prisma on MySQL 8 |
| Web | React, Vite, TypeScript, Tailwind, TanStack Query, React Router |
| Sign-in | Emailed sign-in links and texted codes; EdDSA JWTs; device tokens for provisioned devices |
| Email | Amazon SES outbound; Mailpit locally. Addresses at `patrolkit.io` receive through ImprovMX. |
| SMS | Amazon SNS, from a toll-free number, to US and Canadian numbers |
| Payments | Square for the swap's catalog, inventory and sales (each org connects its own; sandbox or live). PayPal for seller payouts. |
| Photos | Amazon S3 (`PHOTO_BUCKET`) |
| Hosting | EC2, with Caddy in front for TLS and pm2 running the app; the seller site at `skiswap.patrolkit.io` |
