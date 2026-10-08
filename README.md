# PatrolKit — Server

PatrolKit runs a ski patrol's organization:
- members and permissions;
- a ski swap: seller check-in, tags and printing, sales through Square, payouts to sellers through PayPal;
- a time clock;
- provisioned devices: check-in iPads, plus print and scanner bridges.

One installation hosts many organizations. Each one connects its own Square and PayPal accounts from inside the app.

This repository holds the API and the web app. This README covers running it locally and deploying it on your own AWS account.

## How it fits together

```
                        ┌──────────────── EC2 instance ────────────────┐
  app.example.org  ──▶  │  Caddy (TLS)  ──▶  Node.js app on :4000 (pm2) │ ──▶  RDS MySQL 8
  swap.example.org ──▶  │                    API + staff and seller web │ ──▶  S3, SES, SNS
                        └───────────────────────────────────────────────┘
                                                    ▲
                     Square and PayPal (per org) ───┘  Square API calls; PayPal payout webhooks
```

- **One Node.js process serves everything:** the API under `/api/v1`, the staff app under `/app`, and the seller-facing site at the root.
- **Two hostnames point at it:** one for staff, one for sellers. They can be the same host.
- **The app holds no AWS keys.** It uses the EC2 instance role for S3, SES and SNS.

## Run it locally

**Needs:**
- Node.js 22 (20 or later works), pnpm 9 or later, and Docker.
- A [Font Awesome Pro](https://fontawesome.com/plans) license. The web app uses its Pro icons, installed from Font Awesome's private registry. Set your package token once, in your user-level config (never the repository's `.npmrc`):

```bash
pnpm config set "//npm.fontawesome.com/:_authToken" <your Font Awesome package token>
```

Then:

```bash
node scripts/dev-setup.mjs
```

```bash
pnpm dev
```

`dev-setup.mjs` is safe to rerun. It:
1. starts MySQL and Mailpit (`docker-compose.yml`);
2. writes `apps/api/.env` from `.env.example`, with fresh JWT keys;
3. installs dependencies;
4. migrates and seeds the database.

Once `pnpm dev` is running:
- **Web:** http://localhost:3000. It proxies `/api` to the API.
- **API:** http://localhost:4000. `GET /readyz` checks the app and its database.
- **Mailpit:** http://localhost:8025.

To sign in, go to `/app/auth/login` with any seeded user from [`TESTING.md`](TESTING.md). Outbound email and SMS are off by default, so the page shows the sign-in code itself.

| Command | What it does |
|---|---|
| `pnpm dev` | API and web in watch mode |
| `pnpm build` · `pnpm lint` · `pnpm test` | Build, lint, unit tests (Jest for the API, Vitest for the web) |
| `pnpm db:migrate` · `pnpm db:seed` | `prisma migrate dev`, and the seed (permissions, modules, the super admin, demo data in development) |
| `pnpm release` | Deploy to your server (below) |

## Deploy on AWS

### 1. Create the AWS resources

| Resource | Notes |
|---|---|
| **EC2 instance** | Amazon Linux 2023. Give it an Elastic IP. Its security group allows 80 and 443 from anywhere, and SSH only from you (or use EC2 Instance Connect). |
| **RDS MySQL 8** | A database named, say, `patrolkit`. Its security group allows 3306 only from the instance's. |
| **DNS** | A records for your staff and seller hostnames, pointing at the Elastic IP. |
| **SES** | Verify your sending domain (DKIM). Request production access, or SES will only send to verified addresses. Sign-in links, invites and receipts all go by email. |
| **S3 bucket** (optional) | Item photos and org logos, read publicly from `PHOTO_BASE_URL`, so allow public `s3:GetObject`. Without it, logos live in the database and photos go only to Square. |
| **SNS** (optional) | Texted sign-in codes, US and Canadian numbers only. Needs an origination number: a toll-free number registered through AWS End User Messaging. Without it, everyone signs in by email. |
| **IAM role** for the instance | The policy below. |

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["ses:SendEmail"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["sns:Publish"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::YOUR-PHOTO-BUCKET/*" }
  ]
}
```

If you use `DEVICE_IMAGE_BUCKET` for bridge firmware, add `s3:GetObject` on that bucket too.

### 2. Prepare the instance

1. **Software:** install Node.js 22, pm2 (`npm install -g pm2`) and Caddy. Run `pm2 startup` once, so the app comes back after a reboot.
2. **App folder:** create `/home/ec2-user/patrolkit`. The release script deploys there.
3. **Caddy:** add the site to `/etc/caddy/Caddyfile`, then `sudo systemctl enable --now caddy`. Caddy gets and renews the TLS certificates itself.

```
app.example.org, swap.example.org {
    reverse_proxy localhost:4000
}
```

### 3. Configure

Create `/home/ec2-user/patrolkit/.env` from [`.env.example`](.env.example). These matter in production:

| Variable | Set it to |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Your RDS connection string |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | A pair from `node scripts/gen-keys.mjs` |
| `SQUARE_ENCRYPTION_KEY` | `openssl rand -hex 32`. Keep it: changing it orphans every org's stored Square token. |
| `APP_URL` | `https://app.example.org` |
| `SELLER_SITE_URL` | `https://swap.example.org` |
| `COOKIE_DOMAIN` | `example.org` |
| `OUTBOUND_NOTIFICATIONS` | `on`. Anything else sends no email or SMS at all. |
| `MAIL_TRANSPORT`, `EMAIL_FROM`, `SES_REGION`, `AWS_REGION` | `ses`, a verified sender, and your regions |
| `SEED_SUPERADMIN_EMAIL` | Your email: the platform's first super admin |
| `PHOTO_BUCKET`, `PHOTO_BASE_URL`, `AWS_SNS_ORIGINATION_NUMBER` | If you set up S3 and SNS |

### 4. Point the release script at your server

`scripts/release.mjs` deploys over SSH. At the top of the script, set `SERVER` (e.g. `ec2-user@app.example.org`) and `KEY` (your SSH key). When you deploy, set `VITE_SELLER_SITE_URL` to your seller URL, since it's built into the web bundle.

### 5. Deploy

```bash
VITE_SELLER_SITE_URL=https://swap.example.org pnpm release
```

The release:
1. builds the API and web, and fails if the API build emits nothing;
2. rsyncs the build and `prisma/` to the server;
3. installs dependencies there and runs `prisma migrate deploy` and the seed;
4. restarts the app under pm2;
5. waits for `/readyz` to answer.

It warns if `SELLER_SITE_URL` is unset or `OUTBOUND_NOTIFICATIONS` isn't `on`. Run the same command for every later deploy.

### 6. First sign-in

1. Sign in at `https://app.example.org/app/auth/login` with `SEED_SUPERADMIN_EMAIL`.
2. Under **Platform Admin → Organizations**, create an organization. Its owner needs no account yet: one is made and an invite emailed.
3. That org's admin connects its accounts under **Ski Swap → Administration → Settings**:
   - **Square API Configuration:** paste an access token, sandbox or live, from a Square developer application. A swap can't be created until Square is connected.
   - **PayPal Payouts:** to pay sellers. PayPal reports payouts back to `https://app.example.org/api/v1/webhooks/paypal`; register that URL in your PayPal application.

## Operating it

- **Updates:** pull, then `pnpm release`.
- **Migrations are additive only:** new tables and nullable or defaulted columns, never a drop or a rewrite. A deploy can't destroy data, and older code still runs against a newer schema.
- **Rollback:** check out the earlier commit and `pnpm release` it. The migrations stay, and the older code ignores what it doesn't know.
- **Health:** `GET /readyz` checks the app and its database. Point an uptime check or a load balancer at it.
- **Backups:** RDS automated backups cover the data. The instance itself holds only the build and `.env`, so keep a copy of `.env` somewhere safe.
- **Smoke tests:** `apps/api/scripts/smoke-*.mjs` exercise a feature end to end against a running API. Each one's header says how to run it.
  - They work only in a test organization they create, `patrolkit-smoke`, plus an empty `patrolkit-smoke-other` that checks one org can't see another's data.
  - Some stand in for Square or PayPal (`PAYOUTS_STUB=1` and the `SMOKE_*_FILE` variables).
  - To run one against production, copy it and `_fixture.mjs` to the server and run it there with the `.env` loaded (`set -a && . ./.env && set +a`).

## Binding indemnification lists

The Bindings lookup says whether a binding model is on its maker's indemnified list. The models themselves are public, and ship in the item taxonomy. Which ones are indemnified, season by season, comes from licensed lists (NSSRA's combined list is for its members only), so this repository doesn't include it.

To use the lookup, get each season's lists yourself and convert them to the CSV format in [`docs/plan/44_binding_indemnification`](docs/plan/44_binding_indemnification/IMPLEMENTATION_PLAN.md). Then load them through **Platform Admin → Bindings**, or with `pnpm --filter api db:import-indemnification -- <season folder>`. `pnpm --filter api db:export-indemnification -- <folder>` writes a database's lists back out in the same format, for a private backup. Keep these files out of any public repository.

## Repository layout

```
server/
├─ apps/
│  ├─ api/            # NestJS API; serves the built web app in production
│  │  ├─ prisma/      # schema, migrations, seed, item taxonomy
│  │  └─ scripts/     # smoke scripts and one-off tools
│  └─ web/            # React + Vite: the staff app (/app) and the seller site (/)
├─ docs/plan/         # one folder per feature: its implementation plan and iPad handoff
├─ scripts/           # dev-setup.mjs, release.mjs, gen-keys.mjs
├─ docker-compose.yml # MySQL 8 + Mailpit, for local development
└─ .env.example       # every variable the API reads
```

## Stack

| Concern | What it uses |
|---|---|
| API | NestJS, TypeScript, Prisma on MySQL 8 |
| Web | React, Vite, TypeScript, Tailwind, TanStack Query, React Router, Font Awesome Pro |
| Sign-in | Passwordless: emailed sign-in links and texted codes; EdDSA JWTs; device tokens for provisioned devices |
| Email, SMS | Amazon SES; Amazon SNS. Locally, Mailpit. |
| Payments | Square (catalog, inventory, sales) and PayPal (payouts), connected per organization |
| Hosting | EC2, Caddy, pm2; RDS; S3 |

## License

[MIT](LICENSE), © 2026 ovrEngineered, LLC. Font Awesome Pro is licensed separately, by Fonticons, Inc.
