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

**So this is not a modelling problem.** Everything needed already exists:

| Where | What |
|---|---|
| `User.street` / `city` / `state` / `zip` | Mailing address. Global to the person, not per-org. |
| `User.payoutMethod` | `PAYPAL` \| `VENMO` \| `CHECK` \| `DONATE`. |
| `User.payoutChannel` | `email` \| `phone` — which of the person's own contacts receives the money. |
| `PATCH …/ski-swap/seller-self` | Already writes all of the above for the signed-in seller. |
| `POST …/checkin/:swapId/join` | Already creates the `SellerProfile` that endpoint needs. |

No migration. No new endpoint. The work is a screen, a validation rule that was
documented but never written, and the decisions below.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **A payout step, immediately after the name step and before items.** | Answered before anything else, so nobody reaches the end of a swap unpayable. It costs a form between a seller and the thing they queued to do — see §6 for what that risks and how the step earns its place. |
| **D2** | **Three methods: Check, PayPal, Venmo. `DONATE` stays staff-set.** | Donating a whole payout is a decision someone should make deliberately, not tap past on a phone at a table. It remains in the enum and on the staff pages, so a seller who asks can still have it set. Note this is a different thing from `SwapItem.donateProceeds`, which donates one item's proceeds and is unaffected. |
| **D3** | **Required, with the requirement depending on the method.** Check needs a mailing address; PayPal and Venmo need a verified contact. | The point of asking is to be able to pay. A method with no way to reach the person is the same as not asking. |
| **D4** | **PayPal and Venmo pay a contact the seller has already verified, never a typed handle.** | This is the existing design and it is a good one: the seller proved that phone or address at sign-in, so there is one verification concept rather than two, and no opportunity to fat-finger someone else's PayPal. It also means the common case asks for nothing extra — the contact they signed in with is already there. |
| **D5** | **Enforce D4 on the write path.** | `ski-swap.contracts.ts` says "The service layer rejects a channel that is not verified". It does not — `writeUserFields` writes `payoutChannel` straight through. Harmless while only staff set it; load-bearing the moment sellers do. |
| **D6** | **A returning seller sees what is on file and can change it.** | "Paying you by check to 12 Elm St — change?" is one glance and one tap. Skipping silently is faster and quietly produces the undeliverable cheque, because the person who moved house is exactly the person who would not think to go and correct it. |
| **D7** | **Reuse `PATCH …/ski-swap/seller-self`.** | It already accepts these fields for the signed-in seller, and `join` has already created the profile it needs by the time this step runs. A second endpoint would be a second set of rules to keep in step. |
| **D8** | **Address stays on `User`, global to the person.** | Unchanged, and worth stating because the consequence is real: a seller who corrects their address at one org corrects it everywhere. That is the right answer for a mailing address — a person has one — but it means this screen is editing more than the swap in front of them. |

---

## 3. The screen

Between "What should we call you?" and "Add your items", in the same shell as
every other step: instruction as the title, the standard context line beneath.

```
              How should we pay you?
      Demo Org · Ski Swap 2026 · Station 1

   [  Check  ] [  PayPal  ] [  Venmo  ]

   ── when Check ────────────────────────
   Street
   City               State      ZIP

   ── when PayPal or Venmo ──────────────
   Paid to your verified phone
   (555) 555-5555                 Change

                [ Continue ]
```

Three notes on the shape:

- **Check is first and selected by default.** It is the method that needs the
  most typing, so leading with it means the form does not grow after a tap; the
  other two shrink it.
- **PayPal and Venmo normally ask for nothing.** The seller signed in with a
  verified contact minutes ago, so the answer is already known and the screen
  states it rather than asking. "Change" only appears when the person holds a
  second verified contact.
- **A returning seller sees their answers filled in** (D6), with the same
  Continue. No separate confirm screen: the step already reads as a review when
  the fields are populated.

---

## 4. Validation

Enforced server-side, in `writeUserFields`, so the staff pages get it too:

| Method | Requires |
|---|---|
| `CHECK` | `street`, `city`, `state`, `zip` all present |
| `PAYPAL`, `VENMO` | `payoutChannel` set, and the matching contact verified — `email` needs `emailVerifiedAt`, `phone` needs `phoneVerifiedAt` |
| `DONATE` | Nothing |

The client mirrors these to keep Continue disabled rather than bouncing the
seller off a server error, but the server is what decides. A staff member
setting `PAYPAL` against an unverified email should be refused the same way.

**One question for whoever runs payouts:** `payoutChannel`'s comment names
PayPal only, and Venmo is being added to the same mechanism. Venmo identifies
people by phone, email or username; paying to a verified phone should work, but
if payouts are done by username this needs a field and D4 needs revisiting.
Worth confirming before Phase 2 rather than after a swap.

---

## 5. Phases

**Phase 1 — Enforce the rule that is already documented.** Add the verified-
channel check to `writeUserFields` (D5), with tests for each method. Server
only, ships on its own, and fixes the staff path today. Nothing depends on the
rest of this plan.

**Phase 2 — The check-in step.** A `PayoutStep` between name and items, calling
the existing `PATCH …/seller-self` (D7). Prefill from the profile the seller
already has (D6). Mirror the Phase 1 rules client-side.

**Phase 3 — Make the gap visible.** Sellers with no payout method are invisible
until someone tries to pay them. A count on the ski-swap dashboard, and a filter
on the Sellers page, so the people this plan cannot reach — the ones who checked
in before it shipped — can be found and chased.

---

## 6. What this costs, honestly

**A blocking step before items is a real risk.** Sellers queue at a station with
people behind them; a form between them and the thing they came to do is the
kind of friction that produces abandoned check-ins and a staff member taking
over. The step earns its place only if it is genuinely quick, which is why D4
matters more than it looks: for PayPal and Venmo it should be one tap and
Continue, with nothing typed. If it turns out that most sellers pick Check and
type an address, the placement is worth revisiting against the "prompt on the
items screen" alternative.

**It also collects more than the swap needs.** A mailing address is personal
data with no purpose until a cheque is written, and D8 means it is written once
for the person rather than once per org. Worth being deliberate about: only ask
for the address when Check is the method, and do not ask for it speculatively.

**Existing sellers are not reached by any of this.** Anyone who checked in
before Phase 2 still has no payout method, and nothing in the check-in flow will
ask them again unless they return. Phase 3 is what stops that being discovered
at payout time.
