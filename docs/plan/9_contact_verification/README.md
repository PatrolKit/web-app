# Plan 9 — Seller Contact Verification

> **Scope:** Walk-in / anonymous `SwapSeller` records (individual type, no PatrolKit account).
> **Trigger:** Staff-initiated via action buttons in the web UI — not part of the check-in flow.
> **Channels:** Email (link-based) and Phone/SMS (6-digit OTP).
> **Enforcement:** None — verification status is informational only.

---

## Goals

1. Track whether a seller's email and/or phone has been verified.
2. Expose that status on every seller API response.
3. Add staff-facing endpoints to initiate verification per channel.
4. Add public endpoints for sellers to confirm verification.
5. Display status badges and action buttons on `SellersPage`.

---

## Database

### `SwapSeller` — two new fields

```prisma
emailVerifiedAt   DateTime?
phoneVerifiedAt   DateTime?
```

### New model: `SellerVerification`

```prisma
model SellerVerification {
  id        String    @id @default(cuid())
  sellerId  String
  channel   String    // "email" | "phone"
  code      String    // SHA-256 hash of the raw token/OTP
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  seller SwapSeller @relation(fields: [sellerId], references: [id], onDelete: Cascade)

  @@index([sellerId, channel])
}
```

- **Email:** `code` is SHA-256 of a 32-byte random hex token; raw token is sent in a link.
- **Phone:** `code` is SHA-256 of a random 6-digit numeric OTP; raw OTP is sent via SMS.
- Expiry: 15 minutes for both channels.
- Only one active token per `(sellerId, channel)` is needed — a new token supersedes the old one (whichever is confirmed first wins).

---

## API

### Contracts

Add to `SellerResponseSchema`:

```ts
emailVerifiedAt: z.string().datetime().nullable(),
phoneVerifiedAt: z.string().datetime().nullable(),
```

Map the new Prisma fields in `SellerService.toResponse()`.

### New endpoints

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/orgs/:orgId/ski-swap/sellers/:sellerId/verify/email/initiate` | Staff (`manage_swap`) |
| `POST` | `/orgs/:orgId/ski-swap/sellers/:sellerId/verify/phone/initiate` | Staff (`manage_swap`) |
| `POST` | `/public/sellers/:sellerId/verify/email/confirm` | Public |
| `POST` | `/public/sellers/:sellerId/verify/phone/confirm` | Public |

**Initiate** — validates the seller has the relevant contact field set, writes a `SellerVerification` row, dispatches the message, returns `204`.

**Confirm** — public, rate-limited (5 attempts / 10 minutes per seller+channel). Looks up the most recent un-used, non-expired `SellerVerification`, compares SHA-256 of the submitted value to the stored hash. On match: sets `usedAt` and stamps `emailVerifiedAt` / `phoneVerifiedAt`; returns `200`. On mismatch: returns `400`.

### `SellerVerificationService` (new)

Encapsulates all verification logic; injected into `SellerController` and `PublicSellerController`.

```ts
initiateEmail(sellerId: string, orgId: string): Promise<void>
initiatePhone(sellerId: string, orgId: string): Promise<void>
confirmEmail(sellerId: string, rawToken: string): Promise<void>
confirmPhone(sellerId: string, rawCode: string): Promise<void>
```

---

## SMS — AWS SNS

The project uses AWS SES, so AWS SNS is the natural fit — same SDK, same IAM credentials.

1. Use `SNSClient` + `PublishCommand` from `@aws-sdk/client-sns` (transitive dep via SES — no new package).
2. Add config var: `AWS_SNS_ORIGINATION_NUMBER` (a purchased SNS origination or toll-free number).
3. Create `SmsService` mirroring `MailService` with a single `send(to: string, body: string): Promise<void>`.
4. In local/dev: when `AWS_SNS_ORIGINATION_NUMBER` is unset, log the message body instead of sending.

OTP message body: `"Your PatrolKit verification code is: 123456. Expires in 15 minutes."`

---

## Flows

### Email

1. Staff clicks **"Send verification email"** in the seller detail panel.
2. Server writes a `SellerVerification` row and emails a link: `{APP_URL}/app/verify-seller?sellerId=X&token=RAW_TOKEN`.
3. Seller clicks the link → the `/app/verify-seller` page auto-submits `POST /public/sellers/:sellerId/verify/email/confirm`.
4. On success, `emailVerifiedAt` is stamped and the UI refreshes.

### Phone

1. Staff clicks **"Send SMS code"** in the seller detail panel.
2. Server writes a `SellerVerification` row and sends the OTP via SMS.
3. The seller reads the code aloud (walk-ins may not have the web UI open); staff enters it into the OTP modal.
4. Web UI calls `POST /public/sellers/:sellerId/verify/phone/confirm { code }`.
5. On success, `phoneVerifiedAt` is stamped and the UI refreshes.

---

## Web UI (`SellersPage.tsx`)

### Seller list/table

Add small status badges next to the email and phone columns: a green checkmark when verified, a gray dash when not.

### Seller detail panel

Add a **Verification** section with:
- **Email:** verified-at timestamp (or "Not verified") + **"Send verification email"** button (disabled with no email on record).
- **Phone:** verified-at timestamp (or "Not verified") + **"Send SMS code"** button (disabled with no phone on record) + inline 6-digit OTP input + **Confirm** button (shown after initiation).

On initiation: show inline feedback — "Email sent — ask the seller to check their inbox" / "SMS sent — ask the seller for the 6-digit code."

---

## Out of Scope

- Business-seller verification (magic-link sign-in inherently verifies email).
- Clearing `*VerifiedAt` when a contact field is edited.
- Blocking item entry or any other enforcement.
- iOS app changes.

---

## Implementation Order

1. **DB migration** — new fields on `SwapSeller`; new `SellerVerification` table.
2. **`SellerVerificationService`** — core token/OTP logic.
3. **`SmsService`** — AWS SNS wrapper.
4. **`SellerResponseSchema` + `toResponse()`** — expose verification timestamps.
5. **API endpoints** — initiate and confirm for both channels.
6. **Email template** — verification link email in `MailService`.
7. **`/app/verify-seller` page** — handles the email link callback.
8. **Web UI** — badges and action buttons on `SellersPage`.
