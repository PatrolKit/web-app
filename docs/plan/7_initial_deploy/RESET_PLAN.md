# Reset Plan — Tear Down AWS and Deploy Simply

---

## Phase 1 — Tear Down Everything in AWS

Run these commands in order. Each one is reversible until confirmed.

### 1.1 Delete all PatrolKit CloudFormation stacks

```bash
# Delete in reverse dependency order
aws cloudformation delete-stack --stack-name PatrolKit-Api --region us-east-2 --no-cli-pager
aws cloudformation wait stack-delete-complete --stack-name PatrolKit-Api --region us-east-2 --no-cli-pager

aws cloudformation delete-stack --stack-name PatrolKit-Shared --region us-east-2 --no-cli-pager
aws cloudformation wait stack-delete-complete --stack-name PatrolKit-Shared --region us-east-2 --no-cli-pager

aws cloudformation delete-stack --stack-name PatrolKit-Data --region us-east-2 --no-cli-pager
aws cloudformation wait stack-delete-complete --stack-name PatrolKit-Data --region us-east-2 --no-cli-pager

aws cloudformation delete-stack --stack-name PatrolKit-Network --region us-east-2 --no-cli-pager
aws cloudformation wait stack-delete-complete --stack-name PatrolKit-Network --region us-east-2 --no-cli-pager

aws cloudformation delete-stack --stack-name CDKToolkit --region us-east-2 --no-cli-pager
aws cloudformation wait stack-delete-complete --stack-name CDKToolkit --region us-east-2 --no-cli-pager
```

> **Note:** RDS has `deletionProtection: true`. You must disable it manually before the Data stack can be deleted:
> AWS Console → RDS → patrolkit instance → Modify → uncheck Deletion protection → Apply immediately.

### 1.2 Delete ECR images and repository

```bash
aws ecr batch-delete-image --repository-name patrolkit --region us-east-2 \
  --image-ids "$(aws ecr list-images --repository-name patrolkit --region us-east-2 --query 'imageIds[*]' --output json)" --no-cli-pager

aws ecr delete-repository --repository-name patrolkit --region us-east-2 --force --no-cli-pager
```

### 1.3 Delete CDK bootstrap S3 bucket

```bash
BUCKET=$(aws s3api list-buckets --query 'Buckets[?starts_with(Name, `cdk-`)].Name' --output text --no-cli-pager)
aws s3 rb s3://$BUCKET --force
```

### 1.4 Verify everything is gone

```bash
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Project,Values=PatrolKit \
  --region us-east-2 --no-cli-pager \
  --query 'ResourceTagMappingList[*].ResourceARN'
```

The result should be empty.

---

## Phase 2 — Simple Deployment Plan

No CDK. No Docker. No ECR. Just an EC2 instance you configure once and a deploy script that SSHs in and restarts the app.

### What you do (one time)

1. **Launch an EC2 instance** in the AWS console:
   - AMI: Amazon Linux 2023
   - Type: `t3.small` (2 vCPU / 2 GB, ~$15/mo)
   - Key pair: create a new one, download the `.pem`
   - Security group: inbound 22 (your IP only), 80 (anywhere), 443 (anywhere)
   - Elastic IP: allocate one and associate it with the instance

2. **Launch an RDS MySQL 8 instance** in the AWS console:
   - Type: `db.t4g.micro`
   - Same VPC as the EC2 instance, private subnet
   - Security group: inbound 3306 from the EC2 security group only
   - Note the endpoint, username, password

3. **SSH into the instance and install the stack:**

```bash
ssh -i ~/patrolkit.pem ec2-user@<elastic-ip>

# Install Node, pnpm, Caddy
sudo dnf install -y nodejs npm git
sudo npm install -g pnpm

# Install Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/rpm.sh' | sudo bash
sudo dnf install -y caddy

# Configure Caddy (/etc/caddy/Caddyfile)
sudo tee /etc/caddy/Caddyfile << 'EOF'
patrolkit.io {
    reverse_proxy localhost:4000
}
EOF

sudo systemctl enable caddy
sudo systemctl start caddy
```

4. **Create a `.env` file on the server:**

```bash
# /home/ec2-user/patrolkit.env
DATABASE_URL=mysql://user:pass@rds-endpoint:3306/patrolkit
JWT_PRIVATE_KEY=...
JWT_PUBLIC_KEY=...
NODE_ENV=production
PORT=4000
MAIL_TRANSPORT=ses
EMAIL_FROM=noreply@patrolkit.io
APP_URL=https://patrolkit.io
COOKIE_DOMAIN=patrolkit.io
AWS_REGION=us-east-2
```

5. **Point Route 53 A record** for `patrolkit.io` at the Elastic IP.

6. **Run Prisma migrations once:**

```bash
# On the server
cd /home/ec2-user/patrolkit
DATABASE_URL=... npx prisma migrate deploy
DATABASE_URL=... npx ts-node prisma/seed.ts
```

### What `pnpm release` does (every deploy)

Replace the release script with something dead simple:

```bash
# scripts/deploy.sh
rsync -avz --exclude node_modules --exclude .git \
  /path/to/server/apps/api/dist/ \
  ec2-user@<ip>:/home/ec2-user/patrolkit/dist/

ssh ec2-user@<ip> "pm2 restart patrolkit"
```

Or even simpler — just build locally, rsync the compiled output, and restart with `pm2` or `systemd`.

---

## What I broke that needs reverting (code changes)

The following files were changed from their original state and should be reverted to what they were before I touched anything:

| File | What I did |
|---|---|
| `infra/lib/network-stack.ts` | Complete rewrite — remove App Runner, add EC2 SG |
| `infra/lib/api-stack.ts` | Complete rewrite — replace App Runner with EC2 |
| `infra/lib/shared-stack.ts` | Removed SES identity construct |
| `infra/lib/data-stack.ts` | Changed subnet type to PRIVATE_ISOLATED |
| `infra/bin/patrolkit.ts` | Changed props |
| `apps/api/Dockerfile` | Multiple changes: platform, seed compilation, pnpm deploy, etc. |
| `apps/api/entrypoint.sh` | Multiple changes to seed and migration invocation |
| `apps/api/src/prisma/prisma.service.ts` | Made $connect non-fatal (reverted, but confirm) |
| `apps/api/package.json` | Moved ts-node, tsconfig-paths, typescript, prisma to dependencies |
| `package.json` | Added --platform linux/amd64 to image:build |
| `scripts/release.mjs` | Complete rewrite for SSH deploy |
| `pnpm-workspace.yaml` | Fixed corrupted allowBuilds section |

You can reset everything to the last clean git state with:
```bash
git diff --stat HEAD  # see what changed
git checkout HEAD -- .  # revert all uncommitted changes
```

Or selectively revert individual files.

---

## Approval

Tell me which phase to execute and I'll run the commands.
