# EC2 Migration Plan — Replacing App Runner

> **Why:** App Runner was deprecated on 2026-04-30 (no new customers). Switching to a single
> EC2 `t4g.small` instance (~$12/mo) in a public subnet, which also eliminates the NAT Gateway
> (~$33/mo) since the instance has a public IP and RDS is reachable via VPC-internal routing.

---

## Current AWS state (what we keep)

| Stack | Status | What it contains |
|---|---|---|
| `PatrolKit-Network` | `CREATE_COMPLETE` | VPC, public + private subnets, NAT Gateway, App Runner VPC connector |
| `PatrolKit-Data` | `CREATE_COMPLETE` | RDS MySQL 8, `patrolkit/db-credentials`, `patrolkit/jwt-keys` |
| `PatrolKit-Shared` | `UPDATE_COMPLETE` | ECR repo `patrolkit`, SNS alarms, CloudWatch alarms |
| `PatrolKit-Api` | `ROLLBACK_COMPLETE` | **Will be replaced** |

---

## Target architecture

```
Internet
  │  443/80
  ▼
EC2 t4g.small  (public subnet, Elastic IP)
  ├─ Docker: patrolkit:latest
  │    ├─ /api/v1   (NestJS)
  │    └─ /         (React SPA)
  │  VPC-internal (3306, private subnet)
  ▼
RDS MySQL 8 (private subnet)

Secrets Manager
├─ patrolkit/db-credentials
└─ patrolkit/jwt-keys
```

The instance:
- Lives in a **public subnet** with an Elastic IP (no NAT Gateway needed)
- Has a security group allowing 443 and 80 inbound (from anywhere), SSH only from your IP
- Runs Docker with the existing `patrolkit` image from ECR
- Talks to RDS across the VPC (RDS stays in private subnets — no public access)
- Pulls secrets from Secrets Manager via IAM instance profile (no static credentials)

---

## What changes

### CDK changes

**`infra/lib/network-stack.ts`** — Remove:
- The `apprunner` import and `CfnVpcConnector` construct
- The `AppRunnerSg` security group
- The App Runner inbound rule on `DbSg`

Add:
- A security group for the EC2 instance (`ec2Sg`)
- Inbound rules on `ec2Sg`: 443 (0.0.0.0/0), 80 (0.0.0.0/0)
- Inbound rule on `DbSg`: port 3306 from `ec2Sg`
- Export `ec2Sg` as a public property

**`infra/lib/api-stack.ts`** — Replace entirely:
- Remove: ECR repo (moved to SharedStack), App Runner service, VPC connector, App Runner IAM roles
- Add:
  - IAM instance role with: `secretsmanager:GetSecretValue` on db + jwt secrets, `ses:SendEmail`, `logs:*`, `ecr:*`
  - EC2 `t4g.small` instance in the **public subnet** with:
    - The instance role
    - The EC2 security group
    - An Elastic IP associated with the instance
    - `userdata` script that installs Docker, logs in to ECR, pulls `:latest`, and runs the container
  - Output: the Elastic IP address

**`infra/lib/shared-stack.ts`** — No changes needed (ECR repo already lives here).

**`infra/bin/patrolkit.ts`** — Update `ApiStack` props to remove `vpcConnector`, add `ec2Sg`.

### Script changes

**`scripts/release.mjs`** — Replace the App Runner `start-deployment` call with:
1. SSH into the EC2 instance (using the existing `patrolkit-prod-key` key pair)
2. `docker pull` the new `:latest` image from ECR
3. `docker stop` + `docker rm` the old container
4. `docker run` with the same environment (secrets injected via IAM — no env vars needed for secrets if using the AWS SDK credential chain)

Or, simpler: use `aws ssm send-command` to run a deploy script on the instance without needing SSH open.

### `entrypoint.sh` — Keep as-is

The existing entrypoint that parses the DATABASE_URL JSON and runs migrations still works. The only change: instead of App Runner injecting secrets as env vars, the container will fetch them at startup using the AWS SDK via the instance profile. This requires a small change to how the app reads secrets.

**Alternative (simpler):** Pass secrets as Docker `-e` flags in the deploy script, reading them from Secrets Manager at deploy time via the AWS CLI. This avoids any app code changes.

---

## Network stack change: eliminate the NAT Gateway

Because EC2 lives in a **public subnet**, it doesn't need a NAT Gateway to reach the internet (SES, ECR, Secrets Manager). This saves ~$33/mo.

The existing Network stack has `natGateways: 1` which deployed a NAT Gateway. We should:
1. Update `natGateways: 0` in the Network stack
2. Remove the `PRIVATE_WITH_EGRESS` subnet config (replace with `PRIVATE_ISOLATED` for RDS, since RDS only needs VPC-internal access)
3. `cdk deploy PatrolKit-Network` — CloudFormation will delete the NAT Gateway

> **Warning:** This is a destructive change to the Network stack. It will briefly interrupt any
> existing traffic. Since the app is not yet live, this is safe to do now.

---

## Step-by-step execution plan

### Step 1 — Rewrite `NetworkStack`
- Remove App Runner VPC connector and its security group
- Set `natGateways: 0`
- Change private subnet type to `PRIVATE_ISOLATED` (RDS only needs VPC-internal access)
- Add EC2 security group with 443/80 inbound
- Update `DbSg` to allow 3306 from EC2 security group instead of App Runner SG
- Export `ec2Sg`

### Step 2 — Rewrite `ApiStack`
- Replace the entire file with EC2-based construct
- IAM instance role (Secrets Manager read, SES send, ECR pull, CloudWatch Logs)
- `t4g.small` in a public subnet
- Elastic IP
- UserData script to install and start Docker

### Step 3 — Update `bin/patrolkit.ts`
- Remove `vpcConnector` prop, add `ec2Sg` prop to `ApiStack`

### Step 4 — Rewrite `scripts/release.mjs`
- Use SSM `send-command` to pull and restart the container on the instance
- No SSH key required (SSM Session Manager handles auth via IAM)

### Step 5 — Deploy Network stack (removes NAT Gateway)
```bash
pnpm --filter infra cdk deploy PatrolKit-Network --require-approval never
```

### Step 6 — Deploy Api stack (creates EC2 instance)
```bash
pnpm --filter infra cdk deploy PatrolKit-Api --require-approval never
```

### Step 7 — Verify instance is running
```bash
# Get the Elastic IP from stack outputs
# SSH or use SSM to check Docker status
# curl http://<elastic-ip>/healthz
```

### Step 8 — Update Route 53 A records
Replace the old `3.139.205.254` (the long-dead EIP) with the new Elastic IP.

### Step 9 — TLS / HTTPS via Caddy or nginx
The EC2 instance needs to terminate HTTPS. Options:
- **Caddy** (recommended): runs inside Docker alongside the app, auto-provisions Let's Encrypt certs for `patrolkit.io`. Zero config.
- **nginx** + certbot: more common but more setup.
- **ACM + ALB**: adds ~$18/mo for the ALB. Not worth it at this scale.

Caddy as a reverse proxy in the same Docker Compose file is the cleanest path.

---

## Open questions before implementing

1. **TLS strategy:** Caddy sidecar in Docker Compose, or something else?
2. **Secrets injection:** Does the app already use the AWS SDK credential chain to read secrets from Secrets Manager at runtime, or does it expect env vars? (Currently the entrypoint parses `DATABASE_URL` from an env var injected by App Runner — on EC2 we need a different approach.)
3. **Deploy method:** SSM `send-command` (no open SSH) or SSH? SSM requires the SSM agent on the instance, which is included in Amazon Linux 2023 but not Alpine.

---

## Cost after migration

| Item | Cost |
|---|---|
| EC2 `t4g.small` (on-demand) | ~$12/mo |
| Elastic IP (attached, free) | $0 |
| NAT Gateway (removed) | $0 |
| RDS `db.t4g.micro` | ~$14/mo |
| Secrets Manager (2 secrets) | ~$1/mo |
| Route 53 | ~$1/mo |
| SES | ~$0 |
| CloudWatch | ~$1/mo |
| **Total** | **~$29/mo** |
