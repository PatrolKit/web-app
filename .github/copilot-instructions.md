# Copilot Instructions — PatrolKit (server)

PatrolKit is a fresh rebuild delivering a **foundation only**: multi-org support, magic-link
auth, per-org DB-backed permissions, a pluggable module framework, and per-org device
provisioning for a future mobile app. The API also serves the web app at the same origin.

**Authoritative specs:**
- Plan: [docs/plan/IMPLEMENTATION_PLAN.md](../docs/plan/IMPLEMENTATION_PLAN.md)
- Task breakdown: [docs/plan/TASKS.md](../docs/plan/TASKS.md)

## Golden rules (never violate)

- **Foundation only.** Do NOT build any feature module (scheduling, incidents, training,
  equipment, communications) or the mobile app. **No password login** — magic link only.
- **Security invariants:** store only **hashes** — magic-link tokens (SHA-256), refresh tokens
  (SHA-256), device secrets (Argon2id). Never log raw tokens/secrets. Magic-link request always
  returns 200 (no account enumeration). Every org-scoped query is filtered by `orgId` via
  `OrgContextGuard`.
- **Single origin:** the web build is served by the API. Do NOT add S3/CloudFront, a separate web
  origin, browser CORS, Turborepo, or a shared package.
- Stay within the current task's scope. Don't refactor unrelated code or add features/abstractions
  that weren't requested.

## Stack & conventions

- **API:** NestJS + TypeScript + Prisma (MySQL). **Web:** React + Vite + TypeScript + Tailwind +
  TanStack Query + React Router. Monorepo: pnpm workspace at `server/` (`apps/api`, `apps/web`).
- **Validation:** Zod via `nestjs-zod`; contracts live in `apps/api/src/contracts/` and the web
  imports their inferred types via a path alias.
- **API base path:** `/api/v1`. **Response envelope:** success `{ "success": true, "data": … }`;
  error `{ "success": false, "error": "message", "code": "OPTIONAL_CODE" }`.
- **IDs:** cuid. Add `createdAt`/`updatedAt` to mutable models. Validate every endpoint's input
  and reject unknown fields.
- **Auth tokens:** JWT EdDSA (Ed25519); access ~15m, device ~1h; refresh token rotated and stored
  hashed, delivered via httpOnly + Secure + SameSite=Strict cookie.
- **Deployment:** manual from the dev machine; migrations + idempotent super-admin seed run at
  container startup. Region `us-east-2`, domain `patrolkit.io`.

## Execution protocol

- Implement **one task at a time** from `docs/plan/TASKS.md`. Do not start a task until every task
  in its **Depends on** list is complete.
- Keep each task to a single commit (conventional style, e.g. `feat(auth): magic-link verify`).
- Meet the card's **Acceptance criteria** and the **Definition of Done** before finishing.

## Verify before declaring done

```bash
pnpm -r build
pnpm -r lint
pnpm -r test
```

No secrets, raw tokens, or leftover TODOs in committed code.
