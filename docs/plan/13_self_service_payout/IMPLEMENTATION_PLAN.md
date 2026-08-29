# Plan 13 — Asking a self-service seller how to pay them

> **Status:** Proposed.

## 1. The gap

A seller who checks themselves in gives us a contact, a name, and their items.
Nobody asks where they live or how they want the money, so at the end of a swap
their row is complete in every respect except the one that lets us pay them.

The staff path has always asked. The Sellers page and the seller profile page
both edit address and payout, and `PATCH /orgs/:orgId/ski-swap/seller-self`
already accepts every field involved. Self-service was built as the fast path
and the question was never added to it.

Most of what is needed already exists:

| Where | What |
|---|---|
| `User.street` / `city` / `state` / `zip` | Mailing address. Global to the person, not per-org. |
| `User.payoutMethod` | `PAYPAL` \| `VENMO` \| `CHECK` \| `DONATE`. |
| `User.payoutChannel` | `email` \| `phone` — replaced by a wider discriminator, see D5. |
| `PATCH …/ski-swap/seller-self` | Already writes all of the above for the signed-in seller. |
| `POST …/checkin/:swapId/join` | Already creates the `SellerProfile` that endpoint needs. |

Two fields are added and one is removed (D5). No new endpoint.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **A payout step, immediately after the name step and before items.** | Answered before anything else, so nobody reaches the end of a swap unpayable. It costs a form between a seller and the thing they queued to do — see §7 for what that risks. |
| **D2** | **Three methods: Check, PayPal, Venmo. `DONATE` stays staff-set.** | Donating a whole payout is a decision someone should make deliberately, not tap past on a phone at a table. It remains in the enum and on the staff pages, so a seller who asks can still have it set. Different from `SwapItem.donateProceeds`, which donates one item's proceeds and is unaffected. |
| **D3** | **Required, and what is required follows the method.** Check: a full mailing address. PayPal: one of a PayPal ID, a verified phone, or a verified email. Venmo: a Venmo ID. | These are the destinations PayPal Payouts will actually accept, so the form asks for what the payment run can use and nothing else. A method with no usable destination is the same as not asking. |
| **D4** | **Two segmented controls: the method, and — within PayPal — the destination. A typed ID is read back for confirmation; a verified contact is offered rather than typed.** | The nesting follows the domain rather than the layout: PayPal Payouts accepts three recipient types and Venmo effectively one, so PayPal is the only method with a second choice to make. The typed/offered split is not stylistic either — a PayPal or Venmo ID is self-asserted and unverifiable (§5.1), so the only check is a person looking twice, while a verified contact is already proven and cannot be mistyped. |
| **D5** | **Two fields: `payoutTarget` and `payoutHandle`, replacing `payoutChannel`.** | PayPal Payouts needs a recipient *type* as well as a value, so the discriminator is not ours to drop — `payoutTarget` is what it becomes at payout time. `payoutHandle` carries the value only when one was typed; for a phone or email target it stays null and the destination is resolved from `verifiedPhone` / `verifiedEmail` at payout time, so a seller who later changes their email cannot leave a stale copy behind. |
| **D6** | **Every seller confirms their payout details, every check-in, returning or not.** | The unverifiable half of this cannot be checked by anything except a person reading it, and a returning seller is exactly who stops reading. It is also where a moved house or a closed PayPal gets caught, which nothing else in the system will notice. Confirming does not re-verify a contact: no message is sent, and existing verification stands. |
| **D7** | **Reuse `PATCH …/ski-swap/seller-self`.** | It already accepts these fields for the signed-in seller, and `join` has already created the profile it needs by the time this step runs. A second endpoint would be a second set of rules to keep in step. |
| **D8** | **Address stays on `User`, global to the person.** | Unchanged, and worth stating because the consequence is real: a seller who corrects their address at one org corrects it everywhere. That is the right answer for a mailing address — a person has one — but it means this screen is editing more than the swap in front of them. |

---

## 3. The model

```prisma
model User {
  payoutMethod  String? @default("CHECK")   // PAYPAL | VENMO | CHECK | DONATE

  /// What kind of destination the money goes to, and therefore how the payout
  /// run addresses it. Null for CHECK and DONATE.
  ///
  ///   EMAIL | PHONE  — the seller's own verified contact
  ///   PAYPAL_ID      — a PayPal account they typed
  ///   VENMO_ID       — a Venmo account they typed
  ///
  /// The first three are PayPal Payouts' own recipient types, which is why this
  /// is a discriminator rather than a free-text field: the payment run has to
  /// tell them apart, so the form may as well record which was meant.
  payoutTarget  String?

  /// The typed value, for PAYPAL_ID and VENMO_ID only.
  ///
  /// Null for EMAIL and PHONE, where the destination is resolved from
  /// `verifiedEmail` / `verifiedPhone` when the money moves. Storing a copy
  /// would let a seller change their email and leave the payout pointed at the
  /// old one, which is the sort of thing nobody notices until it bounces.
  payoutHandle  String?

  /// Dropped. `payoutTarget` says everything this did and the two cases it
  /// could not express.
  - payoutChannel String?
}
```

**The migration carries the old values across.** `payoutChannel = 'email'`
becomes `payoutTarget = 'EMAIL'`, `'phone'` becomes `'PHONE'`, and
`payoutHandle` stays null — the same destinations, more precisely named. A row
whose channel names a contact that is not verified becomes null, since that row
was never payable and the new fields should not claim otherwise.

**One thing found while writing this, worth recording:** the contract says "The
service layer rejects a channel that is not verified". It does not —
`writeUserFields` writes the value straight through. The rule leaves with the
field it described, but the same class of gap is what D3's validation must avoid
becoming.

---

## 4. The screen

Between "What should we call you?" and "Add your items", in the same shell as
every other step. **Two levels of segmented control**: the method, and — for
PayPal only — where within PayPal the money goes.

```
              How should we pay you?
      Demo Org · Ski Swap 2026 · Station 1

   ┌────────┬────────┬────────┐
   │ Check  │ PayPal │ Venmo  │        ← method
   └────────┴────────┴────────┘
```

**Check** shows a card for the address, and nothing else:

```
   ┌──────────────────────────────────────┐
   │  Where should we post it?            │
   │                                      │
   │  Street                              │
   │  ┌────────────────────────────────┐  │
   │  └────────────────────────────────┘  │
   │  City            State     ZIP       │
   │  ┌───────────┐  ┌─────┐  ┌────────┐  │
   │  └───────────┘  └─────┘  └────────┘  │
   └──────────────────────────────────────┘
```

**PayPal** shows a second segmented control, because Payouts accepts three
kinds of recipient and the seller picks which of theirs to use:

```
   ┌────────────┬────────────┬────────────┐
   │ PayPal ID  │   Email    │   Phone    │   ← destination
   └────────────┴────────────┴────────────┘

   ── PayPal ID ──────────────────────────
   ┌────────────────────────────────────┐
   │ chris@example.com                  │
   └────────────────────────────────────┘
   Whatever your PayPal account is under.

   ── Email ──────────────────────────────
   Sending to chris@example.com  ✓ verified

   ── Phone ──────────────────────────────
   Sending to (555) 555-5555     ✓ verified
```

**Venmo** is a single field, because there is no verified form of a Venmo ID:

```
   Your Venmo ID
   ┌────────────────────────────────────┐
   │ @chris-armenio                     │
   └────────────────────────────────────┘
```

Continue reads the answer back, every time, for everyone:

```
   ┌────────────────────────────────────┐
   │ Sending your money to              │
   │                                    │
   │   @chris-armenio  ·  Venmo         │
   │                                    │
   │ We cannot check this with Venmo,   │
   │ so please make sure it is right.   │
   │                                    │
   │  [ That's right ]  [ Fix it ]      │
   └────────────────────────────────────┘
```

Six notes on the shape:

- **The nested control exists because the recipient types are real.** `EMAIL`,
  `PHONE` and `PAYPAL_ID` are PayPal Payouts' own three, so this segment is not
  a presentational choice — it is the value that goes on the payout, chosen by
  the only person who knows the answer.
- **A verified segment shows the value and asks for nothing.** No field, no
  typing, no way to mistype. The PayPal ID segment is the only one with an
  input, which is why it is the only one carrying the risk in §7.
- **Only verified contacts get a segment.** A seller who signed in by phone and
  never confirmed an email sees two segments, not three. If they have neither —
  which cannot happen today, since sign-in verifies one — PayPal ID stands alone.
- **The PayPal ID field is prefilled with a verified contact** as a starting
  point, since a PayPal account is very often under one of them. It is a
  starting point rather than an answer: whatever is in the box when Continue is
  pressed is what gets paid.
- **The confirmation runs every time, for everyone** (D6) — returning sellers
  included. It is where a moved house or a closed PayPal gets noticed, and it is
  the only check a typed ID ever gets. Its wording follows what is being
  confirmed: an unverifiable ID says as much, an address or a verified contact
  simply states itself.
- **Confirming is not re-verifying.** No email or text is sent. The contact was
  proven at sign-in and stays proven; this asks whether it is still where the
  seller wants the money, which is a different question with a different answer.

**One assumption worth checking:** the destination control opens on a verified
segment when the seller has one, rather than on PayPal ID, so the default path
is the one that cannot be mistyped. The segments are ordered PayPal ID first as
specified; only the initial selection differs.

---

## 5. Validation

Enforced server-side, in `writeUserFields`, so the staff pages get it too:

| Method | `payoutTarget` | `payoutHandle` | Also required |
|---|---|---|---|
| `CHECK` | null | null | `street`, `city`, `state`, `zip` all present |
| `PAYPAL` | `EMAIL` | null | `emailVerifiedAt` set |
| `PAYPAL` | `PHONE` | null | `phoneVerifiedAt` set |
| `PAYPAL` | `PAYPAL_ID` | non-blank | — |
| `VENMO` | `VENMO_ID` | non-blank | — |
| `DONATE` | null | null | — |

Any other combination is refused: `VENMO` with a `PAYPAL_ID` target, `PAYPAL`
with an `EMAIL` target and no verified email, a handle on a target that should
not carry one. The client mirrors these to keep Continue disabled rather than
bouncing the seller off a server error, but the server is what decides.

**Nothing validates a typed ID's shape.** No length rule, no `@` prefix, no
email regex: a Venmo username, a PayPal address and a PayPal payer ID have
nothing in common, and a format check would reject correct answers while still
admitting wrong ones. The only real check is a person reading it back.

### 5.1 Why a typed ID cannot be checked for us

**Re-check this against current documentation before Phase 2** — payment APIs
move and the notes below are from a fixed point in time.

**Neither service offers a lookup, by design.** An endpoint answering "does this
handle have an account" would be an account-enumeration oracle. PayPal does not
offer one; nor does Venmo. `paypal.me/name` resolves or 404s, which tells you a
handle exists and nothing about whose it is.

**PayPal has an authorization flow, which would be better than a lookup.** "Log
in with PayPal" is an OpenID Connect flow returning the account's payer ID and
PayPal-verified email; a payout to a payer ID cannot land unclaimed. It proves
control rather than existence. It is not in this plan — an OAuth round trip on a
phone at a table, with a queue behind, is the wrong moment — but it is the right
eventual answer for PayPal, and belongs on the seller portal framed as "connect
PayPal so we can pay you faster".

**Venmo has no equivalent.** No username resolution, and no identity flow for
third parties — its developer surface is Braintree checkout, which returns a
username in the course of *charging* a customer, the wrong consent to collect
for paying one. A Venmo destination is self-asserted and always will be.

**So the asymmetry is real and should not be papered over.** PayPal is
eventually verifiable and Venmo is not. Until the portal work happens, both are
self-asserted, which is what D4's confirmation exists to mitigate and §7 exists
to catch.

---

## 6. Phases

**Phase 1 — The fields.** Add `payoutTarget` and `payoutHandle`, migrate
`payoutChannel` across, drop it, and add the §5 validation with a test per row
of that table. Update the staff Sellers page and seller profile page. Server and
staff UI only; ships on its own and leaves check-in untouched.

**Phase 2 — The check-in step.** A `PayoutStep` between name and items: the
method control, PayPal's nested destination control, the address card, and the
confirmation — shown to everyone, returning or not (D6). Calls the existing
`PATCH …/seller-self` (D7), prefilled from the seller's profile.

**Phase 3 — Make the gap visible.** Sellers with no payout method are invisible
until someone tries to pay them. A count on the ski-swap dashboard and a filter
on the Sellers page, so the people this plan cannot reach — those who checked in
before it shipped — can be found and chased.

---

## 7. What this costs, honestly

**A blocking step before items is a real risk.** Sellers queue at a station with
people behind them; a form between them and the thing they came to do is the
kind of friction that produces abandoned check-ins and a staff member taking
over. PayPal's verified segments are what keep that path to a glance and two
taps. If it turns out most sellers pick Check and type an address, the placement
is worth revisiting against putting a prompt on the items screen instead.

**A typed ID is a real exposure.** A mistyped PayPal or Venmo ID can send money
to a stranger who has no idea where it came from, and neither we nor the payment
service will notice. The confirmation reduces that; it does not remove it. It is
also why PayPal's destination control opens on a verified segment — the exposure
exists only on the segment with a text field in it, and most sellers need never
select it. Venmo has no such escape: every Venmo destination is typed.

**It collects more than the swap needs.** A mailing address is personal data
with no purpose until a cheque is written, and D8 means it is written once for
the person rather than once per org. Only ask for it when Check is the method.

**Existing sellers are not reached.** Anyone who checked in before Phase 2 still
has no payout method, and nothing will ask them again unless they return. Phase
3 is what stops that being discovered at payout time.

---

## 8. Explicitly out of scope: the payout run

Nothing reads these fields today. There is no payout report, no export and no
integration — the fields are recorded and consumed by nobody, so the money
currently moves by whatever means the treasurer already uses.

That is its own piece of work, and it is where the loose ends here get tied:

- **Whether Venmo can be paid programmatically at all.** Venmo has no send API;
  the route is PayPal Payouts with a Venmo wallet destination, which was gated
  and US-only when last checked. If it is unavailable, Venmo payouts are manual
  and `payoutHandle` is a note for whoever sends them.
- **What happens to a payment that does not land.** PayPal Payouts reports each
  item as `SUCCESS`, `UNCLAIMED`, `RETURNED`, `FAILED` or `BLOCKED`. `UNCLAIMED`
  is the self-asserted handle being wrong, or right but not registered — PayPal
  invites the recipient, and returns the money after roughly a month if nobody
  claims it. Reconciling those is the payout run's job.
- **Flagging self-asserted destinations.** Since trust is derived (D5), a payout
  report can mark which destinations were the seller's verified contact and
  which they typed, and a treasurer can look harder at the second group.

Collecting the data first still stands: it is what that work will need, and it
cannot be gathered afterwards from people who have gone home.
