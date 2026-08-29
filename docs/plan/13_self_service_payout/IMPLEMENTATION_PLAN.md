# Plan 13 — Collecting a self-service seller's address and payout details

> **Status:** Proposed.

## 1. The gap

A seller who checks themselves in gives a contact, a name, and their items.
Nobody asks where they live or how they want the money, so a swap can end with
a row that is complete in every respect except reaching the person or paying
them.

The staff path has always asked. The Sellers page and the seller profile page
both edit address and payout, and `PATCH /orgs/:orgId/ski-swap/seller/me`
already accepts every field involved. Self-service was built as the fast path
and the question was never added to it.

Most of what is needed already exists:

| Where | What |
|---|---|
| `User.street` / `city` / `state` / `zip` | Mailing address. Global to the person, not per-org. |
| `User.payoutMethod` | `PAYPAL` \| `VENMO` \| `CHECK` \| `DONATE`. |
| `User.payoutChannel` | `email` \| `phone` — replaced by a wider discriminator (D6). |
| `PATCH …/ski-swap/seller/me` | Already writes all of the above for the signed-in seller. |
| `POST …/checkin/:swapId/join` | Already creates the `SellerProfile` that endpoint needs. |

Two fields are added and one removed. No new endpoint.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Two steps between the name and the items: address, then payout.** | Both are answered before anything else, so nobody reaches the end of a swap uncontactable or unpayable. Separate rather than combined because they answer different questions — where the person is, and where the money goes — and one screen carrying both would make the address look like a detail of the payout, which is exactly what D2 says it is not. |
| **D2** | **A full address is required of every seller, whatever their payout method.** | An address is not a payout detail that happens to be needed for cheques. It is how a person is reached about their own property — an unsold item to collect, a query about a tag, anything outliving the swap — and a swap where only the cheque-takers can be reached has a gap in it. |
| **D3** | **A destination is required too, and which one follows the method.** PayPal: a PayPal ID, a verified phone, or a verified email. Venmo: a Venmo ID. Check: the address from D2, nothing further. | These are the destinations PayPal Payouts accepts, so the form asks for what the payment run can use and nothing else. A method with no usable destination is the same as not asking. |
| **D4** | **Three methods offered: Check, PayPal, Venmo. `DONATE` stays staff-set.** | Donating a whole payout is a decision to be made deliberately, not tapped past on a phone at a table. It remains in the enum and on the staff pages, so a seller who asks can have it set. Unrelated to `SwapItem.donateProceeds`, which donates one item's proceeds and is unaffected. |
| **D5** | **Two segmented controls: the method, and — within PayPal — the destination.** | The nesting follows the domain rather than the layout. PayPal Payouts accepts three recipient types and Venmo effectively one, so PayPal is the only method with a second choice to make; a control offering Venmo a single option would imply otherwise. |
| **D6** | **Two fields, `payoutTarget` and `payoutHandle`, replacing `payoutChannel`.** | PayPal Payouts needs a recipient *type* as well as a value, so the discriminator is not ours to drop — `payoutTarget` becomes that type at payout time. `payoutHandle` carries a value only when one was typed; for a phone or email target it stays null and the destination resolves from `verifiedPhone` / `verifiedEmail` when the money moves, so a seller who later changes their email cannot leave a stale copy behind. |
| **D7** | **A typed ID is read back for confirmation; a verified contact is offered rather than typed.** | A PayPal or Venmo ID is self-asserted and cannot be checked by anything (§5.1), so a person looking at it twice is the only check available. A verified contact is already proven and cannot be mistyped, so it is offered as a choice and needs no second look. |
| **D8** | **Every seller confirms, every check-in, returning or not.** | A returning seller is exactly who stops reading, and this is where a moved house or a closed PayPal gets caught — nothing else in the system will notice either. Confirming does not re-verify a contact: no message is sent and existing verification stands. |
| **D9** | **The payout step shows the address rather than asking again**, with a way back to change it. | Asking twice is the surest way to collect two different answers, and a seller re-asked for something they typed a screen earlier reasonably assumes the first attempt failed. |
| **D10** | **Reuse `PATCH …/ski-swap/seller/me`.** | It already accepts these fields for the signed-in seller, and `join` has created the profile it needs before either step runs. A second endpoint would be a second set of rules to keep in step. |
| **D11** | **Address stays on `User`, global to the person.** | Unchanged, and worth stating because the consequence is real: a seller who corrects their address at one org corrects it everywhere. That is right for a mailing address — a person has one — but it means these steps edit more than the swap in front of them. |

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
  /// is a discriminator rather than free text: the payment run has to tell them
  /// apart, so the form records which was meant. It also records whether the
  /// destination was proven or self-asserted, without a second field that could
  /// drift out of step with this one.
  payoutTarget  String?

  /// The typed value, for PAYPAL_ID and VENMO_ID only.
  ///
  /// Null for EMAIL and PHONE, where the destination resolves from
  /// `verifiedEmail` / `verifiedPhone` when the money moves. Storing a copy
  /// would let a seller change their email and leave the payout pointed at the
  /// old one, which is the sort of thing nobody notices until it bounces.
  payoutHandle  String?

  /// Dropped. `payoutTarget` says everything this did, and the two cases it
  /// could not express.
  - payoutChannel String?
}
```

**The migration carries the old values across.** `payoutChannel = 'email'`
becomes `payoutTarget = 'EMAIL'`, `'phone'` becomes `'PHONE'`, and
`payoutHandle` stays null — the same destinations, more precisely named. A row
whose channel names a contact that is not verified becomes null, since that row
was never payable and the new fields should not claim otherwise.

The contract that `payoutChannel` belonged to claims "the service layer rejects
a channel that is not verified". It does not: `writeUserFields` writes the value
straight through. The rule leaves with the field it described, and §5 is where
its replacement actually gets enforced.

---

## 4. The screens

Two, between "What should we call you?" and "Add your items", in the same shell
as every other step.

### 4.1 Address

Asked of everyone, whatever they choose next (D2). The subtitle says why: a
seller about to choose Venmo will otherwise wonder what a swap wants with their
address.

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

### 4.2 Payout

The method, and — for PayPal only — where within PayPal the money goes (D5).

```
              How should we pay you?
      Demo Org · Ski Swap 2026 · Station 1

   ┌────────┬────────┬────────┐
   │ Check  │ PayPal │ Venmo  │        ← method
   └────────┴────────┴────────┘
```

**Check** asks for nothing. The address is already known, so the method that
would need the most typing needs none — it shows what will happen, and `Change`
steps back to 4.1 and returns here, so there is one address and one place to
edit it (D9).

```
   ┌──────────────────────────────────────┐
   │  Posting your cheque to              │
   │                                      │
   │  Chris Armenio                       │
   │  12 Elm Street                       │
   │  Burlington, VT 05401     [ Change ] │
   └──────────────────────────────────────┘
```

**PayPal** opens a second control. A verified segment states its value and asks
for nothing — no field, no way to mistype — so the PayPal ID segment is the only
input on the screen, and the only place the exposure in §7 exists.

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

Only verified contacts get a segment: a seller who signed in by phone and never
confirmed an email sees two, not three. The PayPal ID field is prefilled with a
verified contact as a starting point, since a PayPal account is often under one
of them — but it is a starting point, not an answer. Whatever is in the box when
Continue is pressed is what gets paid.

**Venmo** is a single field, because there is no verified form of a Venmo ID.

```
   Your Venmo ID
   ┌────────────────────────────────────┐
   │ @chris-armenio                     │
   └────────────────────────────────────┘
```

**Continue reads the answer back, every time, for everyone** (D8). The wording
follows what is being confirmed: an unverifiable ID says as much, while an
address or a verified contact simply states itself. No message is sent — the
contact was proven at sign-in and stays proven, and this asks a different
question about where the money should go.

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

**One assumption worth checking:** the destination control opens on a verified
segment when the seller has one, so the default path is the one that cannot be
mistyped. The segments stay ordered PayPal ID first as specified; only the
initial selection differs.

---

## 5. Validation

Two kinds of rule, enforced in two places. Collapsing them would break the staff
pages: a staff member correcting only a payout method, on a seller who has no
address on file, must not be refused for a field they were not editing.

**Invariants of the data** — combinations that are wrong whenever they occur.
Enforced in `writeUserFields`, on every write, staff path included:

| Method | `payoutTarget` | `payoutHandle` | Also required |
|---|---|---|---|
| `CHECK` | null | null | — |
| `PAYPAL` | `EMAIL` | null | `emailVerifiedAt` set |
| `PAYPAL` | `PHONE` | null | `phoneVerifiedAt` set |
| `PAYPAL` | `PAYPAL_ID` | non-blank | — |
| `VENMO` | `VENMO_ID` | non-blank | — |
| `DONATE` | null | null | — |

Anything else is refused: `VENMO` with a `PAYPAL_ID` target, `PAYPAL` with an
`EMAIL` target and no verified email, a handle on a target that should not carry
one.

**Completeness of a check-in** — enforced where a check-in completes. A seller
must have `street`, `city`, `state`, `zip` (D2) *and* a method with its
destination before `POST …/checkin/:swapId/finish` succeeds. The client keeps
Continue disabled rather than bouncing anyone off a server error, but `finish`
is what decides, because it is the last moment anything can be required of
someone about to walk away.

**Nothing validates a typed ID's shape.** A Venmo username, a PayPal address and
a PayPal payer ID have nothing in common, so a format rule would reject correct
answers while still admitting wrong ones.

### 5.1 Why a typed ID cannot be checked

**Re-check against current documentation before Phase 2** — payment APIs move,
and this is from a fixed point in time.

**Neither service offers a lookup, by design.** An endpoint answering "does this
handle have an account" would be an account-enumeration oracle. `paypal.me/name`
resolves or 404s, which reveals that a handle exists and nothing about whose it
is.

**PayPal has an authorization flow, which would beat a lookup.** "Log in with
PayPal" is an OpenID Connect flow returning the account's payer ID and
PayPal-verified email; it proves control rather than existence, and a payout to
a payer ID cannot land unclaimed. It is not in this plan — an OAuth round trip
on a phone at a table, with a queue behind, is the wrong moment — but it is the
right eventual answer, and belongs on the seller portal framed as "connect
PayPal so we can pay you faster".

**Venmo has no equivalent and will not.** No username resolution, and no
identity flow for third parties: its developer surface is Braintree checkout,
which returns a username in the course of *charging* a customer — the wrong
consent to collect for paying one.

So the asymmetry is real. PayPal is eventually verifiable and Venmo is not;
until the portal work happens, both are self-asserted, which is what D7's
confirmation mitigates and §8 eventually catches.

---

## 6. Phases

**Phase 1 — The fields and the invariants.** Add `payoutTarget` and
`payoutHandle`, migrate `payoutChannel` across, drop it, and enforce the §5
invariants in `writeUserFields` with a test per row of that table. Update the
staff Sellers page and seller profile page. Server and staff UI only; ships on
its own and leaves check-in untouched.

**Phase 2 — The check-in steps.** An `AddressStep` and a `PayoutStep` between
name and items (D1), both calling `PATCH …/seller/me` (D10) and prefilled from
the seller's profile. The completeness gate on `finish` lands here too, being
meaningless until there are steps that satisfy it.

**Phase 3 — Make the gap visible.** Sellers with no address or no payout method
are invisible until someone tries to reach or pay them. A count on the ski-swap
dashboard and a filter on the Sellers page, so the people this plan cannot
reach — those who checked in before it shipped — can be found and chased.

---

## 7. What this costs, honestly

**Two blocking steps before items.** Sellers queue at a station with people
behind them, and a form between them and the thing they came to do is the kind
of friction that produces abandoned check-ins and a staff member taking over.
Splitting address from payout (D1) is right for clarity and costs a screen. The
address step is the one that always requires typing, so it is where any
abandonment will surface first; if sellers stall there, the fallback is a prompt
on the items screen rather than a gate before it.

**A typed ID is a real exposure.** A mistyped PayPal or Venmo ID sends money to
a stranger who has no idea where it came from, and neither we nor the payment
service will notice. The confirmation reduces this; it does not remove it. PayPal
at least has an escape — most sellers can pick a verified segment and never type
anything — but every Venmo destination is typed.

**It collects an address from people it will never post to.** A seller paid by
Venmo gives a full mailing address that no part of this plan uses, and D11 means
it is written once for the person rather than once per org. That is deliberate
(D2), but it should be defended on the reaching-people ground rather than
treated as free. If it stops being true that a swap needs to reach every seller,
this is the first requirement to drop.

**Existing sellers are not reached.** Anyone who checked in before Phase 2 still
has no payout method, and nothing will ask them again unless they return. Phase
3 is what stops that being discovered at payout time.

---

## 8. Out of scope: the payout run

Nothing reads these fields today. There is no payout report, no export and no
integration, so the money currently moves by whatever means the treasurer
already uses.

That is its own piece of work, and it is where the loose ends here get tied:

- **Whether Venmo can be paid programmatically at all.** Venmo has no send API;
  the route is PayPal Payouts with a Venmo wallet destination, which was gated
  and US-only when last checked. If it is unavailable, Venmo payouts are manual
  and `payoutHandle` is a note for whoever sends them.
- **What happens to a payment that does not land.** PayPal Payouts reports each
  item as `SUCCESS`, `UNCLAIMED`, `RETURNED`, `FAILED` or `BLOCKED`. `UNCLAIMED`
  is a self-asserted handle being wrong, or right but not registered — PayPal
  invites the recipient and returns the money after roughly a month if nobody
  claims it. Reconciling those is the payout run's job.
- **Flagging self-asserted destinations.** `payoutTarget` already distinguishes
  a proven contact from a typed ID, so a report can mark which is which and a
  treasurer can look harder at the second group.

Collecting the data first still stands: it is what that work will need, and it
cannot be gathered afterwards from people who have gone home.
