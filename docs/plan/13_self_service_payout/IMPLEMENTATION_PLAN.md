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
| **D1** | **Two steps between the name and the items: address, then payout.** | Both are answered before anything else, so nobody reaches the end of a swap unpayable or uncontactable. Separate rather than combined because they answer different questions — where the person is, and where the money goes — and one screen carrying both would make the address look like a detail of the payout, which is exactly what D3 says it is not. It costs two forms between a seller and the thing they queued to do; §7 is honest about that. |
| **D2** | **Three methods: Check, PayPal, Venmo. `DONATE` stays staff-set.** | Donating a whole payout is a decision someone should make deliberately, not tap past on a phone at a table. It remains in the enum and on the staff pages, so a seller who asks can still have it set. Different from `SwapItem.donateProceeds`, which donates one item's proceeds and is unaffected. |
| **D3** | **A full address is required of every seller, whatever their payout method.** | An address is not a payout detail that happens to be needed for cheques. It is how a person is reached about their own property — an unsold item to collect, a query about a tag, anything that outlives the swap — and a swap where only the cheque-takers can be reached is a swap with a gap in it. The cost is real and §7 states it: a Venmo seller gives an address nothing in this plan will ever use. |
| **D3a** | **A destination is required too, and which one follows the method.** PayPal: a PayPal ID, a verified phone, or a verified email. Venmo: a Venmo ID. Check: the address from D3, nothing further. | These are the destinations PayPal Payouts will actually accept, so the form asks for what the payment run can use and nothing else. A method with no usable destination is the same as not asking. |
| **D4** | **Two segmented controls: the method, and — within PayPal — the destination. A typed ID is read back for confirmation; a verified contact is offered rather than typed.** | The nesting follows the domain rather than the layout: PayPal Payouts accepts three recipient types and Venmo effectively one, so PayPal is the only method with a second choice to make. The typed/offered split is not stylistic either — a PayPal or Venmo ID is self-asserted and unverifiable (§5.1), so the only check is a person looking twice, while a verified contact is already proven and cannot be mistyped. |
| **D5** | **Two fields: `payoutTarget` and `payoutHandle`, replacing `payoutChannel`.** | PayPal Payouts needs a recipient *type* as well as a value, so the discriminator is not ours to drop — `payoutTarget` is what it becomes at payout time. `payoutHandle` carries the value only when one was typed; for a phone or email target it stays null and the destination is resolved from `verifiedPhone` / `verifiedEmail` at payout time, so a seller who later changes their email cannot leave a stale copy behind. |
| **D6** | **Every seller confirms their payout details, every check-in, returning or not.** | The unverifiable half of this cannot be checked by anything except a person reading it, and a returning seller is exactly who stops reading. It is also where a moved house or a closed PayPal gets caught, which nothing else in the system will notice. Confirming does not re-verify a contact: no message is sent, and existing verification stands. |
| **D7** | **Reuse `PATCH …/ski-swap/seller-self`.** | It already accepts these fields for the signed-in seller, and `join` has already created the profile it needs by the time this step runs. A second endpoint would be a second set of rules to keep in step. |
| **D8** | **Address stays on `User`, global to the person.** | Unchanged, and worth stating because the consequence is real: a seller who corrects their address at one org corrects it everywhere. That is the right answer for a mailing address — a person has one — but it means this step is editing more than the swap in front of them. |
| **D9** | **The payout step shows the address rather than asking again.** Check displays what was entered a screen earlier, with a way back to it. | Asking twice would be the surest way to collect two different answers, and a seller who has just typed their address and is immediately asked for it again reasonably assumes the first attempt failed. |

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

## 4. The screens

Two, between "What should we call you?" and "Add your items", in the same shell
as every other step.

### 4.1 Address

Asked of everyone, whatever they choose next (D3).

```
              Where can we reach you?
      Demo Org · Ski Swap 2026 · Station 1

   For posting a cheque, and for anything
   about your items after the swap.

   Street
   ┌────────────────────────────────────┐
   └────────────────────────────────────┘
   City              State      ZIP
   ┌────────────┐   ┌─────┐   ┌────────┐
   └────────────┘   └─────┘   └────────┘

                [ Continue ]
```

The subtitle says why it is being asked. A seller about to choose Venmo will
otherwise reasonably wonder why a swap wants their address, and "so we can
reach you about your things" is both true and the honest reason it is required
of them (D3).

### 4.2 Payout

**Two levels of segmented control**: the method, and — for PayPal only — where
within PayPal the money goes.

```
              How should we pay you?
      Demo Org · Ski Swap 2026 · Station 1

   ┌────────┬────────┬────────┐
   │ Check  │ PayPal │ Venmo  │        ← method
   └────────┴────────┴────────┘
```

**Check** shows the address from the previous step, already entered (D9):

```
   ┌──────────────────────────────────────┐
   │  Posting your cheque to              │
   │                                      │
   │  Chris Armenio                       │
   │  12 Elm Street                       │
   │  Burlington, VT 05401     [ Change ] │
   └──────────────────────────────────────┘
```

`Change` steps back to 4.1 and returns here, so there is one address and one
place to edit it.

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

Seven notes on the shape:

- **Check asks for nothing on this screen.** The address is already known, so
  the method that needed the most typing now needs none — it shows what will
  happen and offers a way back if it is wrong.
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

Two different kinds of rule, enforced in two different places. Collapsing them
would break the staff pages: a staff member correcting only a payout method on a
seller who has no address on file must not be refused for a field they were not
editing.

**Invariants of the data**, enforced in `writeUserFields` on every write, staff
path included. These are combinations that are wrong whenever they occur:

| Method | `payoutTarget` | `payoutHandle` | Also required |
|---|---|---|---|
| `CHECK` | null | null | — |
| `PAYPAL` | `EMAIL` | null | `emailVerifiedAt` set |
| `PAYPAL` | `PHONE` | null | `phoneVerifiedAt` set |
| `PAYPAL` | `PAYPAL_ID` | non-blank | — |
| `VENMO` | `VENMO_ID` | non-blank | — |
| `DONATE` | null | null | — |

Any other combination is refused: `VENMO` with a `PAYPAL_ID` target, `PAYPAL`
with an `EMAIL` target and no verified email, a handle on a target that should
not carry one.

**Completeness of a check-in**, enforced where a check-in completes rather than
on every write. A seller must have `street`, `city`, `state`, `zip` (D3) *and* a
payout method with its destination before `POST …/checkin/:swapId/finish`
succeeds. The two steps in §4 are what collect them, and the client keeps
Continue disabled rather than bouncing the seller off a server error — but the
finish endpoint is what decides, because it is the last moment anything can be
required of someone who is about to walk away.

This split is what lets staff keep patching one field at a time while a
self-service seller still cannot leave half-known.

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

**Phase 1 — The fields and the invariants.** Add `payoutTarget` and
`payoutHandle`, migrate `payoutChannel` across, drop it, and enforce the §5
invariants in `writeUserFields` with a test per row of that table. Update the
staff Sellers page and seller profile page. Server and staff UI only; ships on
its own and leaves check-in untouched.

**Phase 2 — The check-in steps.** An `AddressStep` and a `PayoutStep` between
name and items (D1). The payout step carries the method control, PayPal's nested
destination control, the Check summary reading back the address just entered
(D9), and the confirmation — shown to everyone, returning or not (D6). Both call
the existing `PATCH …/seller-self` (D7), prefilled from the seller's profile.
The completeness gate on `finish` (§5) lands here too, since it is meaningless
until there are steps that satisfy it.

**Phase 3 — Make the gap visible.** Sellers with no address or no payout method
are invisible until someone tries to reach or pay them. A count on the ski-swap
dashboard and a filter on the Sellers page, so the people this plan cannot reach
— those who checked in before it shipped — can be found and chased.

---

## 7. What this costs, honestly

**Two blocking steps before items is a real risk, and it is now two.** Sellers
queue at a station with people behind them; a form between them and the thing
they came to do is the kind of friction that produces abandoned check-ins and a
staff member taking over. Splitting address from payout (D1) is right for
clarity and costs a screen — the address step is the one that always requires
typing, so it is where any abandonment will show up first. Worth watching once
it is live: if sellers stall there, the fallback is a prompt on the items screen
rather than a gate before them.

**A typed ID is a real exposure.** A mistyped PayPal or Venmo ID can send money
to a stranger who has no idea where it came from, and neither we nor the payment
service will notice. The confirmation reduces that; it does not remove it. It is
also why PayPal's destination control opens on a verified segment — the exposure
exists only on the segment with a text field in it, and most sellers need never
select it. Venmo has no such escape: every Venmo destination is typed.

**It collects an address from people it will never post anything to.** A seller
paid by Venmo gives a full mailing address that no part of this plan uses, and
D8 means it is written once for the person rather than once per org. That is a
deliberate choice (D3) — the address is for reaching someone about their own
property, not only for cheques — but it should be defended on that ground rather
than treated as free. If it ever stops being true that a swap needs to reach
every seller, this is the first requirement to drop.

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
