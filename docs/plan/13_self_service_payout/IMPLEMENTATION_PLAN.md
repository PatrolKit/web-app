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
| `User.payoutChannel` | `email` \| `phone` — being replaced, see D5. |
| `PATCH …/ski-swap/seller-self` | Already writes all of the above for the signed-in seller. |
| `POST …/checkin/:swapId/join` | Already creates the `SellerProfile` that endpoint needs. |

One field is added and one is removed (D5). No new endpoint.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **A payout step, immediately after the name step and before items.** | Answered before anything else, so nobody reaches the end of a swap unpayable. It costs a form between a seller and the thing they queued to do — see §6 for what that risks. |
| **D2** | **Three methods: Check, PayPal, Venmo. `DONATE` stays staff-set.** | Donating a whole payout is a decision someone should make deliberately, not tap past on a phone at a table. It remains in the enum and on the staff pages, so a seller who asks can still have it set. Different from `SwapItem.donateProceeds`, which donates one item's proceeds and is unaffected. |
| **D3** | **Required, with the requirement depending on the method.** Check needs a mailing address; PayPal and Venmo need a destination. | The point of asking is to be able to pay. A method with no way to reach the person is the same as not asking. |
| **D4** | **PayPal and Venmo take a typed destination, prefilled with the seller's verified contact, and confirmed back before the step is left.** | Neither service will confirm a handle in advance (§4.1), so nothing we can build makes this destination trustworthy. Since it cannot be verified, it is instead made deliberate: prefilled so the common case needs no typing, editable because a person's PayPal is often not the contact they signed in with, and read back to them at the end so a wrong answer has to survive being looked at twice. |
| **D5** | **One field, `User.payoutHandle`, replacing `payoutChannel`.** | Two ways to express a destination is one too many: with both, a row can say "pay my verified email" *and* carry a different handle, and nothing decides which wins. One free-text field has one meaning. Trustworthiness is not stored — it is derived, by comparing the handle to `verifiedEmail` and `verifiedPhone`, so it cannot drift out of step with the contacts it describes. |
| **D6** | **A returning seller sees what is on file and can change it.** | "Paying you by check to 12 Elm St — change?" is one glance and one tap. Skipping silently is faster and quietly produces the undeliverable cheque, because the person who moved house is exactly the person who would not think to go and correct it. |
| **D7** | **Reuse `PATCH …/ski-swap/seller-self`.** | It already accepts these fields for the signed-in seller, and `join` has already created the profile it needs by the time this step runs. A second endpoint would be a second set of rules to keep in step. |
| **D8** | **Address stays on `User`, global to the person.** | Unchanged, and worth stating because the consequence is real: a seller who corrects their address at one org corrects it everywhere. That is the right answer for a mailing address — a person has one — but it means this screen is editing more than the swap in front of them. |

---

## 3. The model

```prisma
model User {
  payoutMethod  String? @default("CHECK")   // PAYPAL | VENMO | CHECK | DONATE

  /// Where a PayPal or Venmo payout goes: an email, a phone, or a @username,
  /// as the seller gave it. Null for CHECK and DONATE.
  ///
  /// Free text because neither service will confirm a handle before money is
  /// sent, so there is nothing to validate it against. Whether it is
  /// trustworthy is derived rather than stored — it is a verified destination
  /// exactly when it equals `verifiedEmail` or `verifiedPhone`, which cannot
  /// go stale the way a boolean beside it would.
  payoutHandle  String?

  /// Dropped. Replaced by `payoutHandle`, which can express everything this
  /// could and the cases it could not.
  - payoutChannel String?
}
```

**The migration carries the old values across.** A row with `payoutChannel =
'email'` becomes `payoutHandle = verifiedEmail`, and `'phone'` becomes
`verifiedPhone` — the same destination, written down instead of pointed at.
A row whose channel names a contact that is not verified becomes null, since
that row was never payable and the new field should not claim otherwise.

**One thing found while writing this, worth recording:** the contract says "The
service layer rejects a channel that is not verified". It does not —
`writeUserFields` writes the value straight through. The rule leaves with the
field it described, but the same class of gap is what D3's validation must avoid
becoming.

---

## 4. The screen

Between "What should we call you?" and "Add your items", in the same shell as
every other step.

```
              How should we pay you?
      Demo Org · Ski Swap 2026 · Station 1

   [  Check  ] [  PayPal  ] [  Venmo  ]

   ── when Check ────────────────────────
   Street
   City               State      ZIP

   ── when PayPal or Venmo ──────────────
   Your Venmo
   @chris-armenio
   Your phone, or whatever your Venmo is under.

                [ Continue ]
```

Pressing Continue reads the answer back before accepting it:

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

Four notes on the shape:

- **The handle is prefilled with the verified contact** the seller signed in
  with, so the common case is a glance and two taps. It is editable because a
  person's PayPal is frequently under an address they did not sign in with.
- **The confirmation is not a formality.** It exists because this is the one
  answer on the screen that nothing downstream can check (§4.1), so a person
  reading it back is the only check there is. It says so, rather than pretending
  the step is routine.
- **Check is first and selected by default.** It needs the most typing, so
  leading with it means the form shrinks rather than grows as you choose.
- **A returning seller sees their answers filled in** (D6) and the same
  confirmation, which doubles as the review D6 asks for.

---

## 5. Validation

Enforced server-side, in `writeUserFields`, so the staff pages get it too:

| Method | Requires |
|---|---|
| `CHECK` | `street`, `city`, `state`, `zip` all present |
| `PAYPAL`, `VENMO` | `payoutHandle` present and non-blank |
| `DONATE` | Nothing |

The client mirrors these to keep Continue disabled rather than bouncing the
seller off a server error, but the server is what decides.

**Nothing validates the handle's shape.** No length rule, no `@` prefix, no
email regex: a Venmo username, a PayPal address and a phone number have nothing
in common, and a format check would reject correct answers while still admitting
wrong ones. The only real check is a person reading it back.

### 5.1 Why the handle cannot be checked for us

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

**Phase 1 — The field.** Add `payoutHandle`, migrate `payoutChannel` across,
drop it, and add the D3 validation with tests per method. Update the staff
Sellers page and seller profile page to the new field. Server and staff UI only;
ships on its own and leaves check-in untouched.

**Phase 2 — The check-in step.** A `PayoutStep` between name and items, calling
the existing `PATCH …/seller-self` (D7), prefilled from the seller's profile
(D6), with the confirmation from §4.

**Phase 3 — Make the gap visible.** Sellers with no payout method are invisible
until someone tries to pay them. A count on the ski-swap dashboard and a filter
on the Sellers page, so the people this plan cannot reach — those who checked in
before it shipped — can be found and chased.

---

## 7. What this costs, honestly

**A blocking step before items is a real risk.** Sellers queue at a station with
people behind them; a form between them and the thing they came to do is the
kind of friction that produces abandoned check-ins and a staff member taking
over. Prefilling the handle is what keeps it to a glance and two taps. If it
turns out most sellers pick Check and type an address, the placement is worth
revisiting against putting a prompt on the items screen instead.

**A self-asserted destination is a real exposure.** A mistyped handle can send
money to a stranger who has no idea where it came from, and neither we nor the
payment service will notice. The confirmation reduces that; it does not remove
it. Anyone uncomfortable with that should read §5.1 and weigh Check-only against
the convenience.

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
