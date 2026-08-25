# Plan 10 — User / Identity Consolidation

> **Status:** Draft v3 — for review.
> **Companion:** [`flows.md`](./flows.md) — activity diagrams; the authoritative behavioural spec.
> **Constraint:** The product is 100% pre-production. No existing data needs to be preserved.
> Schema changes are free and migrations may be destructive. **Both the local and the deployed
> database are wiped before the change lands** — the deployed instance is development-only.
> **No API compatibility layer:** the iOS app is updated after this work, not alongside it.
> **No outbound notifications:** all email and SMS is suppressed for the duration — see §6.3.

---

## 1. Problem

Five person-shaped tables exist today and none of them agree on what a person is.

| Table | Scope | Identity key | Contact info | Can authenticate |
|---|---|---|---|---|
| `User` | global | `email` (required, unique) | email only | yes — magic link |
| `Membership` | org | `(userId, orgId)` | — | n/a (carries permissions) |
| `SwapSeller` | org | `(orgId, userId)` when linked; otherwise none | phone (required), email, address, payout, verified-at stamps | no |
| `Patroller` | org | `(orgId, nspId)` | none at all | no |
| `Device` | org | `clientId` | — | yes — client credentials |

The consequences:

- **A business seller is four writes.** `BusinessSellerService.invite()` creates a `User`, upserts a
  `Membership`, grants a `business_seller` permission, and creates *or adopts* a `SwapSeller` with
  `type: 'business'`. The person exists twice.
- **An individual seller is not a person at all** — just an org-scoped `SwapSeller` row, found by
  public lookup (phone, or email + last-4), with no account and no session.
- **A patroller is a third kind of thing**, with no contact info whatsoever. The device matches on
  NSP ID.
- **The same human at two orgs is two-to-six unrelated rows.** A patroller who also sells has no link
  between their roster entry and their seller record, even within one org.
- **Verification is built three times.** `MagicLink` (email tokens), `SellerVerification` (email
  tokens + phone OTPs), and `payoutIdentifierConfirmedAt` (a private confirmation stamp on a
  free-text payout identifier) all implement "prove control of a contact channel."
- **`User.email` is required and unique**, which is exactly what sellers (phone-only) and patrollers
  (neither) violate. `BusinessSellerService` works around the mirror-image problem by writing
  `phone: ''` into `SwapSeller`.

## 2. Goal

**One person record. One org-membership record. One contact-proof primitive.**

Everything a person *is* lives on `User`. Everything a person is *to an organisation* lives on
`Membership`. Role-specific detail hangs off the membership in per-module profile tables. Nothing
person-shaped is duplicated, and nothing person-shaped is ever hard-deleted.

**Out of scope:** record merging (§12), multi-user businesses (§6.4), device authentication, and data
migration — there is no data to migrate.

---

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Global person, org-scoped role.** `User` is the single person record across all orgs; `Membership` is the single org-scoped record. `SwapSeller` and `Patroller` cease to be person tables. | The only shape that yields one source of truth. Both are already org-scoped, so re-parenting them onto `Membership` is a clean swap. |
| **D2** | **Contact is identity.** A person is matched by email, then by phone. | Matches every flow in `flows.md`. |
| **D3** | **Unverified contacts match, but grant nothing.** Staff-entered and CSV-imported contacts are *claims*: they participate in matching immediately, but enable no login, payout, or disclosure until proven. | A roster CSV carries hundreds of unverified emails; refusing to match on them makes import useless. The protection belongs on what a contact *grants*, not on whether it can match. |
| **D4** | **Unique once verified.** At most one `User` may hold a *verified* claim to a given email or phone. Unverified claims may collide. | Keeps verified contacts strong enough to key payouts and login, while tolerating shared and mistyped numbers in the unverified space, where a human is already in the loop. A shared family number resolves naturally: the parent is the point of contact and verifies it, and the child either adds their own email or is simply not separately reachable. |
| **D5** | **One membership per `(user, org)`, roles layered on top.** A patroller who also sells at their own mountain is one membership with two profiles. | `@@unique([userId, orgId])` already exists. Role = presence of a live profile row. |
| **D6** | **Import matches blindly** on email then phone — no review queue, no ambiguity handling. | Chosen for V1 simplicity. Cost recorded in §12. |
| **D7** | **Soft removal everywhere.** Memberships and profiles carry `deletedAt` and are never hard-deleted. | Offline devices sync the roster on `updatedSince` and must receive tombstones: a device that only ever sees live rows can never learn that someone left the roster. |
| **D8** | **One `ContactChallenge` primitive** replaces `MagicLink` and `SellerVerification`. Confirming a challenge stamps the contact verified and, depending on its purpose, mints a session. | Verification and login are the same act. Building them separately is how the codebase ended up with three implementations. |
| **D9** | **Payout targets a verified contact**, not a free-text identifier. `payoutIdentifierType`, `payoutIdentifier` and `payoutIdentifierConfirmedAt` are deleted. | Removes the third verification concept. PayPal Payouts becomes "pick one of your verified contacts." |
| **D10** | **Disclosure is gated on a human act.** Cross-org search reveals **name only**; the full record follows once staff confirm identity with the person in front of them. | Taken from the *Staff Adds Individual Seller* flow. A human gate is simpler than a system rule and is already how the workflow runs. |
| **D11** | **Contactless people are allowed.** A CSV row with neither email nor phone still creates a `User`. | The import flow's fall-through branch. Such a person cannot log in, be paid, or be matched later — accepted; see §12. |
| **D12** | **`business_seller` is retired as a permission.** Self-service access is gated on having a live seller profile in the org. | Individual sellers now log in too, so a permission meaning "may exist as a self-service seller" no longer distinguishes anything. |
| **D14** | **NSP ID is global, and is a third matching key.** `User.nspId` is unique platform-wide; matching tries nspId, then email, then phone. It is a *matching* key only — it addresses no channel, so it can never mint a session. | An NSP id is issued nationally, one per human. Global uniqueness lets a roster import at one org match a patroller already known at another with no contact info at all, which is what shrinks D11's cost for patrollers. |
| **D15** | **Person data is global.** `patrolLevel`, `street`, `city`, `state`, `zip`, `payoutMethod` and `payoutChannel` live on `User`, not on the profiles. | They describe the human, not the relationship: an address is an address, and a patrol level is a national certification. D10's confirmation step is what gates another org seeing them. |
| **D16** | **One lifecycle field.** `deletedAt` on `Membership` and on the profiles is the only status. `Membership.status` and `User.status` are deleted. | "Disabled" and "removed" were never distinct enough to justify two fields, and the existing enable/disable toggle becomes clear/set `deletedAt` with no change in UX. `User.status` is read in exactly one place (`AuthService.requestMagicLink`) and written nowhere — a global kill switch nothing can throw. |
| **D13** | **`businessName` lives on `SellerProfile`, not `User`.** `User` holds only the human — `firstName`, `lastName`, contacts. The profile holds the trading identity at that org. It also replaces the old `type` enum: `businessName != null` ⇒ business. | A session is minted by proving control of a contact, so it must belong unambiguously to a person, not to a person-and-shop hybrid. `businessName` is a ski-swap concept and belongs beside `nspId` on a profile, not in the identity spine. Lets the same person sell as a business at one org and an individual at another, and leaves a clean path to multi-user businesses. Cost in §12. |

---

## 4. Target data model

### 4.1 `User` — the person

```prisma
model User {
  id        String @id @default(cuid())

  /// The human. Both nullable: a walk-in known only by a phone number has neither.
  firstName String?
  lastName  String?

  /// Issued nationally, one per human — a matching key, never an auth key (D14).
  /// Normalised by `normalizeNspId`: non-alphanumerics stripped, upper-cased,
  /// leading zeros preserved.
  nspId       String? @unique
  patrolLevel String?

  // Global, because they describe the human rather than one relationship (D15).
  street String?
  city   String?
  state  String?
  zip    String?

  payoutMethod  String? @default("CHECK") // PAYPAL | VENMO | CHECK | DONATE
  /// Which of this person's contacts receives a PayPal payout. Must be verified (D9).
  payoutChannel String?                   // email | phone

  email           String?
  emailVerifiedAt DateTime?
  /// Mirror of `email`, written only when verified. Unique index enforces D4.
  verifiedEmail   String?   @unique

  /// E.164 normalised.
  phone           String?
  phoneVerifiedAt DateTime?
  /// Mirror of `phone`, written only when verified. Unique index enforces D4.
  verifiedPhone   String?   @unique

  isSuperAdmin Boolean @default(false)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  memberships   Membership[]
  challenges    ContactChallenge[]
  refreshTokens RefreshToken[]

  @@index([email])
  @@index([phone])
}
```

`email` and `phone` are indexed but **not** unique — unverified claims may collide (D4).

**`verifiedEmail` / `verifiedPhone`.** MySQL has no partial unique index, so "unique only when
verified" needs a materialised column. These are written by application code inside the same
transaction that stamps `emailVerifiedAt` / `phoneVerifiedAt`, and nulled when a contact is changed
or unverified. Exactly one code path writes them (`ContactChallengeService.confirm`), the unique
index still rejects concurrent duplicates, and Prisma stays in charge of the schema. A MySQL 8
`GENERATED ALWAYS AS (...) STORED` column would also work and cannot drift, but requires a
hand-authored migration and permanently diverges from `prisma migrate diff`.

**Names.** `User` carries only the human's name — there is no stored display name and no concatenated
column to keep in sync. Display is derived by one helper, `displayName(user, sellerProfile?)`, which
returns `sellerProfile.businessName` when present, else `"First Last"`, else the person's email or
phone. `PatrollerResponse` already exposes a computed `displayName`, so the pattern exists. The
roster keeps `lastName` as a real sort key.

### 4.2 `Membership` — the person, to an organisation

```prisma
model Membership {
  id       String   @id @default(cuid())
  userId   String
  orgId    String
  joinedAt DateTime @default(now())

  /// Delta-sync watermark. Deliberately NOT `@updatedAt` — see §8.
  updatedAt DateTime
  /// Soft removal from the org, and the only lifecycle field (D7, D16).
  deletedAt DateTime?

  user        User                   @relation(fields: [userId], references: [id], onDelete: Cascade)
  org         Organization           @relation(fields: [orgId], references: [id], onDelete: Cascade)
  permissions MembershipPermission[]

  sellerProfile    SellerProfile?
  patrollerProfile PatrollerProfile?

  @@unique([userId, orgId])
  @@index([orgId, updatedAt])
  @@index([orgId, deletedAt])
}
```

### 4.3 Profiles — role-specific, one row per membership

`SwapSeller` and `Patroller` survive as *profiles*: the person columns move up to `User`, the
org-scoped role columns stay. Because the profiles keep their own ids, **every existing foreign key
and API field name is unchanged** — `SwapItem.sellerId`, `TimeClockShift.patrollerId`,
`SwapPrinter.assignedSellerId` and the public `/s/:sellerId` URL all keep working against the profile
id. That also keeps the public seller identifier distinct from the internal membership id, so a
leaked seller URL can be rotated without touching the membership.

```prisma
model SellerProfile {
  id           String  @id @default(cuid())
  membershipId String  @unique

  /// Set ⇒ this membership sells on behalf of a business; null ⇒ individual (D13).
  businessName String?

  deletedAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  membership       Membership    @relation(fields: [membershipId], references: [id], onDelete: Cascade)
  swapItems        SwapItem[]
  assignedPrinters SwapPrinter[]
}

model PatrollerProfile {
  id           String @id @default(cuid())
  membershipId String @unique

  /// On the roster at this mountain but not currently patrolling. Genuinely
  /// org-scoped, unlike nspId and patrolLevel, which are on `User` (D14, D15).
  active Boolean @default(true)

  deletedAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  membership Membership       @relation(fields: [membershipId], references: [id], onDelete: Cascade)
  shifts     TimeClockShift[]
  events     TimeClockEvent[]
}
```

Both profiles are deliberately thin. Once person data is global (D15), a profile carries only what is
true of that person *at that org* — plus two things that make it load-bearing regardless: a stable id
that anchors `SwapItem.sellerId`, `TimeClockShift.patrollerId` and the public seller URL, and a
`deletedAt` that grants or revokes the role. A profile is a role marker with an identity, not a data
bag.

Neither profile carries an `orgId` column; queries scope via `where: { membership: { orgId } }`. This
removes a denormalised key that can drift; the cost is in §12.

### 4.4 `ContactChallenge` — the one proof primitive

Replaces `MagicLink` and `SellerVerification`.

```prisma
model ContactChallenge {
  id       String @id @default(cuid())
  userId   String
  channel  String // email | phone
  /// Snapshot of the address being proven, so a later edit cannot retarget a live challenge.
  target   String
  /// login | verify | invite — controls TTL and whether confirmation mints a session.
  purpose  String
  codeHash String

  attempts  Int       @default(0)
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, channel, usedAt])
}
```

- **Lookup is always by `id`**, never by hash. Email links carry `?c=<id>&t=<token>`; the send-code
  endpoint returns the challenge id to the SMS page. This is what lets a 32-byte email token and a
  6-digit OTP share one table, since a unique index on `codeHash` cannot work for OTPs.
- **`attempts` is capped at 5 per challenge.** Today the only protection on a 6-digit OTP is the
  IP-based `@Throttle({ ttl: 600_000, limit: 5 })` on `PublicSellerController`; nothing is recorded
  against the verification row itself, so a distributed attempt is unbounded.
- **TTL by purpose:** `login` 15 min, `verify` 15 min, `invite` 30 days — preserving the existing
  business-seller invite behaviour.
- Issuing a challenge for a `(userId, channel, purpose)` supersedes any outstanding one.

### 4.5 Removed

| Removed | Replaced by |
|---|---|
| `SwapSeller.name` | `User.firstName`/`lastName` for individuals, `SellerProfile.businessName` for businesses |
| `SwapSeller.type` | `SellerProfile.businessName != null` (D13) |
| `SwapSeller.email` / `phone` / `emailVerifiedAt` / `phoneVerifiedAt` | `User` |
| `SwapSeller.payoutIdentifierType` / `payoutIdentifier` / `payoutIdentifierConfirmedAt` | `User.payoutChannel` (D9, D15) |
| `SwapSeller.street` / `city` / `state` / `zip` / `payoutMethod` | `User` (D15) |
| `Patroller.firstName` / `lastName` | `User` |
| `Patroller.nspId` | `User.nspId`, now globally unique (D14) |
| `Patroller.patrolLevel` | `User` (D15) |
| `User.status`, `Membership.status` | `Membership.deletedAt` (D16) |
| `MagicLink`, `SellerVerification` | `ContactChallenge` (D8) |
| `business_seller` permission row | a live `SellerProfile` (D12) |

---

## 5. Identity & contact rules

1. **Matching.** Find by `nspId` (normalised) where the source has one, else by `email`
   (case-folded), else by `phone` (E.164), else create. NSP ID leads because it is an issued
   identifier rather than a contact channel, so it neither changes nor is shared. Verification status
   is irrelevant to matching (D3).
2. **Claiming.** Writing an unverified `email` or `phone` onto a `User` is a claim. Claims may
   collide with other claims. A claim that collides with someone else's **verified** contact is
   rejected, and staff get the disambiguation prompt the *Staff Adds Individual Seller* flow already
   draws.
3. **Proving.** Confirming a `ContactChallenge` stamps the `…VerifiedAt` field and mirrors the value
   into `verifiedEmail` / `verifiedPhone`. If the unique index rejects it, someone else already
   proved that contact: surface a conflict, never merge.
4. **Unproving.** Editing a verified contact clears both the stamp and the mirror in one transaction.
5. **Granted only by verified contacts:** session minting, PayPal payout targets, and full-record
   disclosure to an org the person has not acted at. `nspId` grants none of these — it addresses no
   channel, so there is nothing to send and nothing to prove (D14).
6. **NSP ID collisions are hard errors.** Two orgs entering the same nspId for different humans means
   one of them mistyped it. The unique index rejects the second write, and the import reports the row
   as an error naming the existing holder. Unlike a contact collision there is no unverified space to
   fall back into, so it must be fixed at the source.

---

## 6. Authentication

### 6.1 One login, two channels

`POST /auth/login` accepts `{ email }` **or** `{ phone }`. Email sends a magic link, phone sends a
6-digit OTP; both create a `purpose: 'login'` challenge and both confirm into the same session. The
existing refresh-rotation, cookie and logout machinery in `AuthService` is untouched. Requests return
a uniform 200 whether or not the person exists — the current no-enumeration behaviour, extended to
phone.

### 6.2 What changes for sellers

Business-seller authentication does not change in mechanism — it was always a `User` with a magic
link. What changes is that it stops being special, and individual sellers gain the same capability:

- Invite still creates the person, the membership and a 30-day `invite` challenge. It no longer
  grants a permission or creates a second person row. It collects business name and email only, so it
  creates a `User` with an email and no name, plus a profile carrying the business name; the human
  fills in their name at first login.
- `SellerSelfController` drops `@RequirePermissions('business_seller')` for a new
  `SellerProfileGuard`, which loads the caller's live `SellerProfile` for `:orgId` and attaches it to
  the request. Individual sellers reach the same endpoints by the same route.
- Business-only capability — bulk item entry, printer assignment — derives from
  `sellerProfile.businessName != null`, checked in `SellerSelfService`.
- The unguessable `/s/:sellerId` QR page survives as the no-login fast path for viewing item status.

The result is one self-service implementation instead of two, and it unblocks both drivers behind
this work: PayPal Payouts needs a verified email or phone, and self-service check-in needs to prove
"we found you" without exposing a stranger's details. Both are the same primitive as login.

### 6.3 Outbound notifications are off

No email or SMS reaches anyone while this work is in progress. `OUTBOUND_NOTIFICATIONS` is a
**fail-closed** master switch read by both `MailService.send` and `SmsService.send`: unless it is
explicitly set to `on`, each logs and returns before touching SES, SNS or SMTP. It defaults to `off`,
so an unset variable suppresses rather than sends.

This sits *above* the existing transport config rather than replacing it. Local dev was already inert
— `MAIL_TRANSPORT=smtp` points at Mailpit on `localhost:1025`, and `SmsService` already stubbed when
`AWS_SNS_ORIGINATION_NUMBER` was unset — but neither protects the deployed instance, and the
integration suite genuinely calls `POST /auth/magic-link` for a *known* user, which reaches
`MailService`. The switch makes suppression a property of the application rather than of one
environment's configuration.

Two consequences to carry forward:

- **Production must set `OUTBOUND_NOTIFICATIONS=on`.** Nothing else turns it on. This is deliberate
  — the failure mode of forgetting is silence, not a mis-sent invite.
- **Seed and test fixtures use unroutable contacts**: `@example.com` (RFC 2606) and `+1555xxxxxxx`
  (the reserved fictional range), so even a mistakenly-enabled switch cannot reach a real person.

`prisma/seed.ts` sends nothing at all — it is pure Prisma writes — so wiping and re-seeding either
database delivers no mail.

### 6.4 Known limitation

A business *is* the login, so a shop with two staff who both need access shares a mailbox. Accepted
for V1. Because `businessName` sits on the profile (D13), lifting this later means adding a second
`User` with their own membership and profile — no reshaping of the person table.

---

## 7. Roles & permissions

- **A role is a live profile row.** `sellerProfile != null && deletedAt == null` ⇒ seller at this
  org; same for patroller. Revoking a role sets `deletedAt`, re-granting clears it.
- **Permissions keep their existing meaning** as *capabilities* (`ski_swap:manage`,
  `time_tracking:admin`, …). Only `business_seller` is retired.
- `PermissionsService.getPermissions` returns nothing for a membership with `deletedAt != null`,
  replacing its current `status !== 'active'` check (D16).
- `OrgContextGuard` rejects memberships with `deletedAt != null`, and no longer consults
  `membership.status`. `Organization.status` is untouched.
- The business-seller enable/disable toggle becomes clear/set `deletedAt`; the UX is unchanged.

---

## 8. Soft removal & device sync

Offline time-clock devices pull the roster with `?updatedSince=` and rely on tombstones. After
consolidation a roster row is assembled from **three** tables — `User` (name, NSP ID, patrol level),
`Membership` (removal) and `PatrollerProfile` (active) — so a per-table `@updatedAt` would let a
rename or a patrol-level correction on `User` slip past a device's watermark forever. D15 sharpens
this: most of a roster row now lives on `User`.

**`Membership.updatedAt` is the single watermark** for everything about a person at an org, and it is
maintained explicitly:

- It is declared `updatedAt DateTime`, deliberately *not* `@updatedAt`, so nobody assumes it is
  automatic.
- One helper owns it:

  ```ts
  // MembershipTouchService
  touch(membershipId: string): Promise<void>
  touchAllForUser(userId: string): Promise<void>   // rename, contact change
  ```

- It is called from exactly three places: user writes (`firstName`, `lastName`, `nspId`,
  `patrolLevel`), membership writes (deletion, permissions), and profile writes.
- A test asserts the invariant that editing any roster-visible field on `User` bumps the watermark of
  every membership they hold. This is the drift risk, so it gets an explicit guard.

Computing `GREATEST(user.updatedAt, membership.updatedAt, profile.updatedAt)` in the roster query
cannot drift, but needs `$queryRaw` for the whole list endpoint including cursor ordering. The
explicit touch keeps the endpoint in Prisma and concentrates the risk in one tested helper.

**Tombstones.** A roster row is a tombstone when either `membership.deletedAt != null` or
`patrollerProfile.deletedAt != null` (D16 removes the third case). The roster query
filters on `membership.orgId` plus *has a patroller profile* — including soft-deleted ones — and
derives the existing `deletedAt` and `active` fields of `PatrollerResponse` from those three sources.
The wire contract is unchanged.

**Open shifts.** No open shift outlives its patroller: `closeOpenShift` still runs on deactivate and
on removal, and still does so by writing an `admin` clock-out event and recomputing, so events remain
the single source of truth.

---

## 9. Flow mapping

Each diagram in [`flows.md`](./flows.md) maps to one service method. Both import diagrams place "add
… membership user to org" outside the `while` loop; it is read here as per-row.

| Flow | Service | Behaviour |
|---|---|---|
| **Previous Individual Seller Import** | `SellerImportService.importCsv` | Per row: match email → match phone → create (D6, D11), then upsert membership + `SellerProfile` with no `businessName`. **No notification.** |
| **Staff Adds Individual Seller** | `SellerService.search` + `.add` | `search` returns **name only** across all users (D10). On confirm, `add` upserts membership and profile, then returns the full record for editing. With no match, staff enter details and contacts are stored unverified. |
| **Staff Adds Business Seller** | `BusinessSellerService.invite` | Autocomplete over business profiles, name only. With no match: create user from email, membership, and `SellerProfile{businessName}`. **Always notify by email.** |
| **Self-service Check-in** | `PublicCheckinService` | QR carries `orgId`. Person enters email or phone → match, else sign-up form (name, address, email, phone) → create. A `login` challenge confirms, stamping the contact verified, minting a session, and upserting membership + individual seller profile. The only flow where a contact arrives self-entered and therefore trustworthy. |
| **Patroller Import** | `PatrollerService.importCsv` | Per row: match nspId → email → phone → create (D14), then upsert membership + `PatrollerProfile`. A colliding nspId errors the row (§5.6). **Notify only if the user pre-existed *and* has a verified contact.** |
| **Bulk onboarding** *(new)* | `PatrollerService.sendOnboarding` | Explicit UI action over unverified patrollers; issues `verify` challenges in bulk. Replaces notify-on-import for new rows. |

---

## 10. API surface

**New**

- `POST /auth/login` — `{ email }` or `{ phone }`; issues a login challenge.
- `POST /auth/challenges/:id/confirm` — `{ code }`; verifies the contact and mints a session.
- `POST /orgs/:orgId/users/search` — name-only cross-org lookup by email or phone (D10). `POST`
  rather than `GET` so the contact stays out of the URL.
- `POST /public/checkin/:orgId` and its confirm — self-service check-in.
- `POST /orgs/:orgId/time-clock/patrollers/onboarding` — bulk onboarding.

**Changed**

- `/auth/magic-link` → folded into `/auth/login`.
- `/public/sellers/:sellerId/verify/{email,phone}/confirm` → folded into challenge confirm.
- `/public/:orgSlug/ski-swap/seller-find` (email + last-4) → **removed**, superseded by self-service
  check-in.
- `orgs/:orgId/ski-swap/seller/me/*` → `SellerProfileGuard` in place of
  `@RequirePermissions('business_seller')`.
- Seller and patroller responses source name, contact, NSP ID, patrol level, address and payout
  fields from `User`.
- `MemberResponse.status` is dropped; membership presence and `deletedAt` carry it (D16).

**Unchanged:** the `/s/:sellerId` public page, device token exchange, all time-clock event and shift
endpoints, and the roster sync wire contract.

**iOS impact.** The seller endpoints under `orgs/:orgId/ski-swap/sellers` are device-authenticated,
so the iOS app reads contracts this plan reshapes — `name` splits, contact/address/payout move to
`User`, and `type` becomes `businessName`. Device token exchange and the roster contract are
deliberately preserved, so time-clock sync is unaffected. The seller contract is cut over cleanly and
the iOS app follows afterwards; no compatibility shim is built.

---

## 11. Work breakdown

Ordered so the tree builds and tests pass at every step.

**Phase 0 — Notifications off, then schema.** Land the `OUTBOUND_NOTIFICATIONS` kill switch (§6.3)
before anything else, so no subsequent phase can send by accident.

**Phase 0b — Schema.** Rewrite `schema.prisma` per §4 as a single destructive migration. Wipe and
re-migrate both the local and the deployed database — the deployed instance is development-only and
holds nothing worth keeping, but the wipe is a deliberate, separately-run step, not a side effect of
the migration. Rewrite `seed.ts` to drop the `business_seller` permission and seed people with
contacts. Update `scripts/dev-setup.mjs` if it seeds sellers or patrollers.

**Phase 1 — Contact-proof primitive.** Build `ContactChallengeService` (issue, confirm, attempt cap,
supersede). Fold `MailService.sendMagicLink` and `sendVerificationEmail` plus the `SmsService` OTP
into it. Delete `SellerVerificationService`. Add two-channel `/auth/login`, keeping refresh rotation
as-is.

**Phase 2 — Membership as the org person record.** Add `MembershipTouchService` and the watermark
invariant test (§8). Teach `OrgContextGuard` and `PermissionsService` to honour `deletedAt` and drop
their `status` checks (D16), and convert the enable/disable paths in `MembersService` and
`BusinessSellerService` to clear/set `deletedAt`. Change `MembersService` to match on nspId, email or
phone rather than email alone.

**Phase 3 — Ski swap code cutover.** Repoint reads onto `SellerProfile` and `User`. Add
`SellerProfileGuard` and retire `business_seller` from `SellerSelfController`. Reduce
`BusinessSellerService.invite` to one person, one membership, one profile. Add `PublicCheckinService`
and remove `seller-find`. Point payout at a verified contact (D9).

**Phase 4 — Time clock code cutover.** Repoint reads onto `PatrollerProfile` and `User`, moving
`nspId` and `patrolLevel` uniqueness and normalisation from `PatrollerService`'s org scope to the
global index (D14). Assemble the roster list from three tables with tombstone derivation, preserving
`closeOpenShift`. Match roster import on nspId then contact, surface collisions as row errors, and
add the onboarding action.

**Phase 5 — Web UI.** Collapse `SellersPage`, `BusinessSellerPage`, `SellerImportModal` and
`SellerProfilePage` onto one seller concept with name-only search and a confirm step. Add contact
columns, verified badges and bulk onboarding to `RosterPage` and `RosterImportModal`. Show all roles
a person holds on `MembersPage`. Delete `VerifySellerPage`, folding it into the unified confirm page.

**Phase 6 — Cleanup.** Delete dead contracts and DTOs, update the permission list in
`org.contracts.ts` and its spec, and refresh README and TESTING.

---

## 12. Accepted costs

- **Blind matching (D6).** A CSV typo that happens to hit a real contact silently attaches that row
  to the wrong person. Bounded by rule §5.2 — a claim cannot collide with someone else's verified
  contact — so damage is confined to unverified space.
- **Contactless people (D11).** A person imported with neither email nor phone can never be matched
  again, and will duplicate if they reappear with contact info. D14 removes this for patrollers, who
  always carry an NSP ID; it stands for walk-in sellers.
- **Any org may edit global fields (D15).** Patrol level, address and payout live on `User`, so a
  roster or seller admin at one org edits them for every org. For patrol level that is the point — a
  national certification should have one value. For payout it is sharper, since an admin at one org
  can change where another org's money lands. Accepted for V1 on the grounds that the payout belongs
  to the person either way; restricting payout edits to the person themselves is the obvious
  follow-up if it bites.
- **NSP ID collisions block the second org (D14).** A mistyped nspId at one org occupies that value
  globally, so the real holder's import elsewhere errors until someone fixes the typo. Visible and
  correctable, but it is a cross-org failure that did not exist when the key was org-scoped.
- **No merge flow.** Two `User` rows *will* turn out to be one human — via D11, via a D4 conflict,
  via a shared family phone. Until merge exists the answer is manual DB surgery. Acceptable
  pre-production; the first follow-up.
- **Business-name drift (D13).** `businessName` is free text on an org-scoped row, so one shop
  selling at two orgs is two strings that can diverge ("Acme Ski Shop" vs "Acme Ski"), and the
  business autocomplete would surface both. On `User` there would be exactly one spelling. This
  disappears once businesses become first-class entities.
- **No denormalised `orgId` on profiles (§4.3).** Every profile query joins through `Membership`.
  Cheap at this scale, but the existing `@@index([orgId, …])` access patterns move onto the
  membership indexes.
