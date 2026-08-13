# PatrolKit — Initial Deploy Tasks

Execution breakdown of [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) into atomic, verifiable
tasks. Work through tasks in order.

> **State as of 2026-08-12 (live audit):** CDK NOT bootstrapped. Route 53 zone, SES identity,
> DKIM records, and DNS delegation are already complete. Old server EIP `eipalloc-061ea36a405c5e598`
> has been released; A records in Route 53 still point to `3.139.205.254` (now gone); site is currently down.

---

## D0 — Fix CDK conflicts with pre-existing resources

**Type:** CDK code change
**Touches:** `infra/lib/shared-stack.ts`, `infra/lib/api-stack.ts`

**What to do:**

Remove the `ses.EmailIdentity` construct from `SharedStack` — the identity already exists and
CloudFormation cannot create a duplicate. Replace the dynamic `sesIdentityArn` property with a
hardcoded ARN string and pass it through to `ApiStack`.

In `infra/lib/shared-stack.ts`:
- Delete the `const emailIdentity = new ses.EmailIdentity(...)` block
- Set `this.sesIdentityArn` to the literal string
  `'arn:aws:ses:us-east-2:058264065670:identity/patrolkit.io'`
- Remove the `ses` import if it becomes unused

In `infra/lib/api-stack.ts`, confirm the IAM policy for SES send still uses the `sesIdentityArn`
prop (no change needed there — the value just changes from a dynamic token to a string).

**Do NOT** add a `route53.PublicHostedZone` to `NetworkStack` — the zone already exists.

**Acceptance criteria:**
- [ ] `pnpm --filter infra build` — no TypeScript errors
- [ ] `pnpm infra:synth` — no errors, produces valid CloudFormation JSON
- [ ] Synthesized template contains no `AWS::SES::EmailIdentity` resource
- [ ] Synthesized template contains no `AWS::Route53::HostedZone` resource
- [ ] `PatrolKit-Api` stack template still has an IAM policy with `ses:SendEmail` action
      scoped to `arn:aws:ses:us-east-2:058264065670:identity/patrolkit.io`

---

## D1 — CDK bootstrap

**Type:** Operational (one-time)
**Depends on:** D0

```bash
cdk bootstrap aws://058264065670/us-east-2
```

**Acceptance criteria:**
- [ ] `CDKToolkit` stack is `CREATE_COMPLETE` in CloudFormation (`us-east-2`)
- [ ] An S3 bucket prefixed `cdk-` exists in `us-east-2`

---

## D2 — Deploy all CDK stacks

**Type:** Operational
**Depends on:** D1

```bash
pnpm infra:deploy
```

Save the output values to a local scratch file (do NOT commit):
- `PatrolKit-Data.DbSecretArn`
- `PatrolKit-Data.JwtSecretArn`
- `PatrolKit-Data.DbEndpoint`
- `PatrolKit-Network.VpcId`
- `PatrolKit-Network.VpcConnectorArn`

**Acceptance criteria:**
- [ ] All four stacks reach `CREATE_COMPLETE` in CloudFormation
- [ ] ECR repository `patrolkit` exists in `us-east-2`
- [ ] App Runner service `patrolkit` exists (may be in a non-RUNNING state — no image yet)
- [ ] RDS instance `patrolkit` exists in private subnets

---

## D3 — Populate JWT signing keys in Secrets Manager

**Type:** Operational
**Depends on:** D2

```bash
node scripts/gen-keys.mjs
# Copy the two values into /tmp/jwt-payload.json as:
# { "JWT_PRIVATE_KEY": "<base64>", "JWT_PUBLIC_KEY": "<base64>" }

JWT_SECRET_ARN=$(aws --no-cli-pager secretsmanager describe-secret \
  --secret-id patrolkit/jwt-keys \
  --query ARN --output text --region us-east-2)

aws --no-cli-pager secretsmanager put-secret-value \
  --secret-id "$JWT_SECRET_ARN" \
  --region us-east-2 \
  --secret-string file:///tmp/jwt-payload.json

rm /tmp/jwt-payload.json
```

**Acceptance criteria:**
- [ ] `aws --no-cli-pager secretsmanager get-secret-value --secret-id patrolkit/jwt-keys --region us-east-2 --query SecretString --output text`
      returns a JSON object where neither `JWT_PRIVATE_KEY` nor `JWT_PUBLIC_KEY` is the string `REPLACE`
- [ ] The temp file `/tmp/jwt-payload.json` has been deleted

---

## D4 — Build and push the Docker image

**Type:** Operational
**Depends on:** D2

Ensure Docker Desktop is running and the AWS CLI session is active.

```bash
pnpm image:build
pnpm image:push
```

**Acceptance criteria:**
- [ ] ECR repository `patrolkit` contains an image tagged `:latest`
- [ ] ECR image scan shows no `CRITICAL` severity findings (review scan results in the ECR console
      before proceeding — do not deploy a critically vulnerable image)

---

## D5 — Trigger first App Runner deployment

**Type:** Operational
**Depends on:** D3, D4

```bash
pnpm release

# Monitor status
SERVICE_ARN=$(aws --no-cli-pager apprunner list-services \
  --region us-east-2 \
  --query "ServiceSummaryList[?ServiceName=='patrolkit'].ServiceArn" \
  --output text)

watch -n 10 "aws --no-cli-pager apprunner describe-service \
  --service-arn $SERVICE_ARN \
  --region us-east-2 \
  --query 'Service.{Status:Status,URL:ServiceUrl}'"
```

If the deployment fails, check CloudWatch Logs at `/aws/apprunner/patrolkit/<id>/application`.
Common causes: JWT keys still have placeholder values (D3 not complete), Prisma migration fails.

**Acceptance criteria:**
- [ ] App Runner service status is `RUNNING`
- [ ] `curl https://<apprunner-default-url>/healthz` returns `{"status":"ok"}`
- [ ] Startup logs contain no `[ERROR]` entries for migration or seed

---

## D6 — App Runner custom domain + DNS cutover

**Type:** Operational
**Depends on:** D5

> This step takes `patrolkit.io` from "currently down" to "live on App Runner". The existing
> A records in Route 53 still point to `3.139.205.254` (now a dead IP — EIP already released)
> and need to be replaced.

```bash
# Associate both domains
aws --no-cli-pager apprunner associate-custom-domain \
  --service-arn "$SERVICE_ARN" \
  --domain-name patrolkit.io \
  --region us-east-2

aws --no-cli-pager apprunner associate-custom-domain \
  --service-arn "$SERVICE_ARN" \
  --domain-name www.patrolkit.io \
  --region us-east-2
```

From each response, note the `CertificateValidationRecords` CNAMEs and the `DNSTarget` hostname.

**In Route 53 (zone `Z04621431O4OWAZ87K7NH`):**

1. Add all `CertificateValidationRecords` CNAME records.
2. Update the `patrolkit.io` A record: change from value `3.139.205.254` to an ALIAS pointing
   to the App Runner `DNSTarget`.
3. Update the `www.patrolkit.io` A record: same change.

Check validation:
```bash
aws --no-cli-pager apprunner describe-custom-domains \
  --service-arn "$SERVICE_ARN" \
  --region us-east-2 \
  --query 'CustomDomains[*].{Domain:DomainName,Status:Status}'
```

**Acceptance criteria:**
- [ ] Both `patrolkit.io` and `www.patrolkit.io` show `Status: ACTIVE` in App Runner custom domains
- [ ] `curl -I https://patrolkit.io/healthz` returns `HTTP/2 200` and body `{"status":"ok"}`
- [ ] Browser confirms valid TLS certificate for `patrolkit.io`

---

## D7 — Smoke testing

**Type:** Operational
**Depends on:** D6

Run each check manually:

| # | Check | Expected |
|---|---|---|
| 1 | `curl -I https://patrolkit.io/healthz` | `HTTP/2 200`, body `{"status":"ok"}` |
| 2 | `https://patrolkit.io` in browser | Landing page renders |
| 3 | Navigate to web app route | React SPA loads, no console errors |
| 4 | POST `/api/v1/auth/magic-link` with your email | `{"success":true}` |
| 5 | Check inbox | Email arrives from `noreply@patrolkit.io` |
| 6 | Follow the magic link | Redirected to app; auth cookies set |
| 7 | GET `/api/v1/auth/me` with cookies | Returns current user object |

**Acceptance criteria:**
- [ ] All 7 checks pass
- [ ] No `[ERROR]` or `5xx` log entries in CloudWatch during the smoke test

---

## D8 — Monitoring: SNS subscription and alarm verification

**Type:** Operational
**Depends on:** D2

```bash
TOPIC_ARN=$(aws --no-cli-pager sns list-topics \
  --region us-east-2 \
  --query "Topics[?contains(TopicArn,'patrolkit-alarms')].TopicArn" \
  --output text)

aws --no-cli-pager sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol email \
  --notification-endpoint <your-email> \
  --region us-east-2
```

**Acceptance criteria:**
- [ ] SNS email subscription is `Confirmed`
- [ ] CloudWatch alarms `PatrolKit-Api-5xx`, `PatrolKit-RDS-CPU`, `PatrolKit-RDS-Connections`
      all exist in `OK` state
- [ ] Log group `/aws/apprunner/patrolkit/` is visible in CloudWatch Logs

---

## Completion checklist

- [ ] D0 — CDK conflicts fixed; `infra:synth` passes clean
- [ ] D1 — CDK bootstrapped; `CDKToolkit` stack `CREATE_COMPLETE`
- [ ] D2 — All four stacks deployed and `CREATE_COMPLETE`
- [ ] D3 — JWT keys populated in Secrets Manager; temp file deleted
- [ ] D4 — Docker image built and pushed to ECR; no critical CVEs
- [ ] D5 — App Runner running; health check passes on default URL
- [ ] D6 — Custom domains active; HTTPS confirmed
- [ ] D7 — All smoke tests pass
- [ ] D8 — SNS subscription confirmed; CloudWatch alarms in OK state
