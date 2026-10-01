# Plan 29 — Running without SMS

AWS has not approved a toll-free originator after a month of trying. Until it
does, no text PatrolKit sends ever arrives: every one is suppressed at
`SmsService.send`. But the screens still offer them:
- sign in by phone;
- "Text me a code";
- "Verify by text";
- "Text Receipt".

Each looks like it works, and then doesn't.

This plan adds a platform-wide **SMS** switch, off by default.
- **Off:** every SMS feature and every mention of texting is hidden, on the web
  and the iPad, and the server refuses what the screens no longer offer.
- **On:** everything is as it is today, with no data to repair.

Phone numbers stay. People and sellers can still have one, stored, searched and
shown as today. While SMS is off it can't be verified, so it shows as
unverified.

---

## 1. Decisions

| | |
|---|---|
| **Where the switch lives** | A one-row platform settings table, default off, changed from a new **Configuration** tab in Platform Admin without a deploy. §2, §5 |
| **Signing in** | Email only. A phone-only person can still be served at a staffed counter, where nobody signs in. If they try to sign in, they're told to use an email. §3 |
| **Phone numbers** | Kept and shown. New ones can't be verified. Phones verified before stay verified. §3 |
| **Enforcement** | On the server, not just the screens. Every path that would text either refuses, or takes the email path, before anything is created. §3 |
| **Refusals** | One short line each, saying what to do instead. §3 |
| **PayPal to a phone** | Unchanged: it's a payout destination, not a text from us. It needs a verified phone, so new sellers aren't offered it, and existing ones keep it. |
| **Legal and marketing pages** | `terms.html`, `privacy.html` and `landing.html` keep their SMS text. It describes the program for when texting is on, and AWS's reviewers look for it while registration is pending. |
| **iPad** | Reads the switch from the Ski Swap settings it already syncs. A missing value reads as off. §6 |

---

## 2. The switch

**Schema:** a new one-row table. It's additive, and the migration inserts the
row with `smsEnabled = false`. Whether to migrate in place or wipe is asked at
deploy time, as with every schema change.

```prisma
/// Platform-wide settings. Exactly one row, id 1.
model PlatformSettings {
  id          Int      @id @default(1)
  smsEnabled  Boolean  @default(false)
  updatedAt   DateTime @updatedAt
  updatedById String?
}
```

**`PlatformSettingsService`** (`src/platform/`):
- `get()` reads the row and caches it in memory. The API is a single process, so
  `update()` refreshes the cache directly and nothing goes stale.
- `smsEnabled()` is the shortcut the callers in §3 use.

**Endpoints:**

| Route | Who | Returns |
|---|---|---|
| `GET /admin/settings` | Super admin | `{ smsEnabled, updatedAt, updatedBy, smsReadiness }` |
| `PATCH /admin/settings` | Super admin | Body `{ smsEnabled }`. Returns the same shape. |
| `GET /public/features` | Anyone | `{ sms: boolean }`, for the sign-in and check-in pages, which run before anyone is signed in. |

- **`smsReadiness`** says whether texts would actually leave with the switch on:
  `{ originationNumber: boolean, outboundNotifications: boolean }`, from the
  existing config. It never returns the number itself.
- **`/public/features`** takes `@Limit('public.reads')`, like the other `/public`
  routes.

---

## 3. The server, with SMS off

`SmsService.canText` already answers "would a text to this number go?". It gains
a first check: with SMS off, it returns `{ ok: false, reason: SMS_OFF }`. Most
callers already handle a refusal from it, and each gets its own one-line
sentence. Older iPad builds show that sentence as-is, as does anyone who reaches
a hidden path through a bookmark.

| Where | Today | With SMS off |
|---|---|---|
| **Sign in** (`AuthService.requestLogin`) | A phone number gets a texted code. | `400 SMS_OFF`: *"Use your email to sign in."* It comes **before** the account lookup, so it's the same for every number and reveals nothing about who has an account. |
| **Self check-in** (`CheckinService.channelFor`) | Phone first, email as fallback. | Email. With no email: `400 CANNOT_TEXT`, *"Use your email to sign in."* |
| **Staff verifying a seller's phone** (`seller.controller` `verify/phone/initiate`) | Texts a code. | `400 CANNOT_TEXT`: *"Texting is off. Verify their email."* |
| **Time Clock onboarding** (`PatrollerService.sendOnboarding`) | A phone-only patroller gets a texted code. | Skipped, and counted in `skipped`. |
| **Receipts** (`receipt.service`) | `SMS` when asked for, or when there's no verified email. | Never `SMS` by default. Asking for it gets `400`: *"Texting is off. Send it by email."* The seller's `receiptChannel` is never `SMS`, so screens that read it offer email or nothing. |
| **Payout nudges** (`payout-nudge.service`) | Texted when there's no verified email. | Email only. A seller with only a verified phone isn't nudged, and that's logged like a seller with no contact. |
| **`SmsService.send`** | Suppressed (no originator). | Suppressed with *"Texting is off"*: the backstop for anything missed above. |

**Unchanged:**
- **Phone numbers** on users and sellers: entry, import, search, matching and
  display.
- **`phoneVerifiedAt` / `verifiedPhone`.** Nothing is cleared.
- **PayPal payouts to a verified phone** (`build-run.ts`).
- **The `sms.site` limit,** shown on Server health, where it reads zero while
  nothing is sent.

Nothing is rewritten while SMS is off, so turning it back on restores everything
at once.

---

## 4. Where the web reads it

**`useFeatures()`** is one hook, backed by React Query on `GET /public/features`,
and used by every screen in §5.
- It's cached for the session and refetched when the window regains focus.
- While loading, SMS counts as off. A text option that appears late beats one
  that's offered and then refused.

---

## 5. The web, with SMS off

**Platform Admin → Configuration** is a new tab at
`/dashboard/admin/configuration`, after Device Telemetry. It's built to take more
settings later, but this plan adds only one. It shows:
- **"Text messages (SMS)"**, a toggle described as: *"Sign-in codes, phone
  verification, texted receipts and payout reminders by text. While off, they're
  hidden everywhere, and phone numbers are kept but can't be verified."*
- **A readiness line** under the toggle, from `smsReadiness`, when the switch is
  on but texts still wouldn't leave:
  - *"No origination number is set, so texts are logged, not sent."*
  - *"Outbound notifications are off, so nothing is sent."*
- **Last changed:** by whom, and when.

**Hidden or reworded:**

| Screen | File | With SMS off |
|---|---|---|
| Sign in | `pages/auth/LoginPage.tsx` | Email only, with no Phone/Email switch. The subtitle reads "Sign in with your email". No SMS consent paragraph, and no texted-code step. |
| Self check-in, sign in | `pages/checkin/SignInStep.tsx` | Email only. No "Text me a code", no consent text, and no "Text me a new code". |
| Self check-in, finish | `pages/checkin/FinishStep.tsx` | The receipt link goes only to the verified email. No "Text me a link to my receipt". |
| Sellers | `pages/ski-swap/SellersPage.tsx` | No phone Verify button and no code entry. The phone shows as "(unverified)", as `UsersTab` already does. |
| Print receipt | `pages/ski-swap/PrintReceiptModal.tsx` | "Text Receipt" can't appear, since `receiptChannel` is never `SMS`. The empty state reads "No verified email on file…". |
| Platform users | `pages/admin/UsersTab.tsx` | Unchanged. It already marks an unverified phone. |

The search placeholder "Search name, email or phone" stays, because phones are
still searched.

---

## 6. The iPad

A handoff note goes to the iOS side (`patrolkit_ios/docs/plan/23_no_sms/`).

**The flag:**
- `GET orgs/{orgId}/ski-swap/settings` gains `smsEnabled: boolean`.
  - The switch is platform-wide, but this sends it with the settings the app
    already syncs.
  - A missing value reads as off, the same rule as `legacyTicketsEnabled`.
- It flows `APISkiSwapSettings` → `SkiSwapSettingsRecord` (a new column, by
  migration) → `SkiSwapContext`.

**Hidden while off:**
- **Seller detail:**
  - the "Text" receipt row is hidden;
  - "…Email or text the receipt instead" becomes "Email the receipt instead";
  - the phone Verify button on `ContactRow` is replaced by "Unverified".
- **Payout setup:** "Verify by text" is hidden. A phone is selectable only once
  verified, as now, so an unverified phone simply isn't offered.
- **No contact:** "No verified email or phone…" becomes "No verified email…".

**An older build that still offers these** gets a refusal with a sentence (§3),
not a silent failure:
- `verify/phone/initiate` returns `400 CANNOT_TEXT`;
- a receipt sent with `channel: "SMS"` returns `400`.

---

## 7. Not in this plan

- **Getting the originator approved.** It's tracked separately. When it lands,
  set the origination number, then turn the switch on.
- **Per-org SMS settings.** The switch is platform-wide: one AWS account, one
  originator.
- **Removing SMS code.** All of it stays, behind the switch.
- **Editing the legal and landing pages** (§1).
- **Re-verifying or clearing phones** verified before the switch.

---

## 8. Testing

**Unit:**
- **`PlatformSettingsService`:**
  - it defaults to off;
  - `update` is seen by the next `get` without a restart.
- **`canText`:** returns `SMS_OFF` before the country and ceiling checks.
- **Each row of §3, with SMS off:**
  - phone sign-in is refused the same way for a known and an unknown number;
  - check-in picks email, or refuses when there's no email;
  - staff phone verification is refused;
  - onboarding skips phone-only patrollers;
  - receipts never default to `SMS` and refuse it when asked, and
    `receiptChannel` is never `SMS`;
  - nudges skip phone-only sellers;
  - `send` suppresses.
- **The same rows with SMS on** behave as today.
- **Endpoints:**
  - `/admin/settings` is super-admin only;
  - `/public/features` needs no token and returns only `{ sms }`.

**Web:** checked in the browser, since the web has no component-test setup.
With SMS off, sign-in and self check-in are email-only. The Configuration tab
toggles, and shows its readiness lines and who last changed it.

**Smoke** (`smoke-no-sms.mjs`), over real HTTP:
- the switch starts off, and `/public/features` says so;
- phone sign-in returns `SMS_OFF`;
- check-in with a phone and an email sends an email link;
- staff phone verification is refused;
- a receipt asked for by `SMS` is refused, and the default goes by email;
- turning the switch on with `PATCH /admin/settings` makes phone sign-in issue a
  challenge again;
- the smoke turns the switch back off.

The older smokes that sign sellers up by phone (`smoke-checkin`,
`smoke-sent-receipts`, `smoke-send-limits`, `smoke-tall-receipt`) turn texting on
for their run with `textingOnForRun`, and put it back afterwards, even if they
crash.

**By hand:**
- With the switch off, walk the sign-in page, self check-in and a seller's page,
  on the web and on the iPad. No mention of texting anywhere.
- Turn it on, and confirm everything is back.

---

## 9. Order

1. `PlatformSettings`, its service, and the admin and public endpoints (§2).
2. Server enforcement (§3), all at once. Half-enforced, it would refuse things
   the screens still offer.
3. `useFeatures`, the Configuration tab, and the web screens (§4, §5).
4. `smsEnabled` on Ski Swap settings, and the iOS handoff note (§6).

Steps 1–3 ship together. Deployed alone, step 2 would leave the web's phone
sign-in in place, failing with a sentence instead of hidden.
