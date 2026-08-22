---
name: project-seller-verification
description: Plan 9 — seller contact verification feature shipped Aug 2026
metadata:
  type: project
---

Plan 9 (Seller Contact Verification) implemented and deployed on 2026-08-20.

**Why:** Staff needed a way to verify walk-in seller email/phone addresses; informational only, no enforcement.

**What was built:**
- DB: `emailVerifiedAt`/`phoneVerifiedAt` on `SwapSeller`, new `SellerVerification` table (SHA-256 hashed tokens/OTPs, 15-min expiry)
- `SmsService` (AWS SNS) + `SmsModule` (global) — `AWS_SNS_ORIGINATION_NUMBER` env var; stubs to logger when unset
- `MailService.sendVerificationEmail()` for the email link flow
- `SellerVerificationService` — initiate + confirm for both channels
- Staff endpoints (require `ski_swap:manage`): `POST /orgs/:orgId/ski-swap/sellers/:sellerId/verify/email/initiate` and `/phone/initiate`
- Public endpoints (rate-limited 5/10min): `POST /public/sellers/:sellerId/verify/email/confirm` and `/phone/confirm`
- Frontend: verification badges (green checkmark) on phone/email columns; "Verify" button opens modal with email send + OTP entry; `/app/verify-seller` page for email link callback

**How to apply:** When touching seller response shapes or adding new seller endpoints, remember `emailVerifiedAt`/`phoneVerifiedAt` are now part of `SellerResponse`.
