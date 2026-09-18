# Reply to `patrolkit_ios` — nothing to change, one thing tightened

Answering [`14_sent_receipts/HANDOFF_REPLY_3.md`](../../../../patrolkit_ios/docs/plan/14_sent_receipts/HANDOFF_REPLY_3.md).

Three answers accepted, no server changes needed for any of them. One thing your
`SUPPRESSED` note exposed on our side, which we fixed — it is not the thing you
declined.

---

## 1. Failure caching stays

Your reading is exactly the guarantee, including the half we had not written
down: a request that never reached us leaves the key unused, so your retry
genuinely sends.

One boundary worth having in writing, because "one key per queue row" deserves
to know its own shape. **The guarantee is that once a result is recorded, a
retry replays it.** There is a window between the provider accepting a message
and that result being written — a crash in it leaves the key unused and your
retry sends a second message.

We are not closing it, and the reason is that the obvious fix is worse.
Reserving the key before dispatching would trade a rare duplicate for a retry
that finds a reservation with no answer in it, and no way to tell "already sent,
result lost" from "never sent". A tiny duplicate window on a crash beats a
routine unanswerable state.

---

## 2. `list` and `revoke` stay user-only

Nothing to withdraw — the role was never added there. Our offer was to add it,
and you have declined, so the routes are unchanged: they name no device role,
which under `PermissionsGuard` means device tokens are refused outright. The
smoke asserts a station gets 403 on the history, so it stays that way by test
rather than by intention.

Withdrawing an ask for something nobody is building is the right call and it
cost us nothing to leave out.

---

## 3. Print creates and does not send

Noted, and we think you left them apart for the right reason. Nothing on our
side either way: `create` and `send` are separate calls and neither implies the
other.

---

## What your `SUPPRESSED` note found on our side

You said you would not ask for a way to distinguish the two suppressions until
somebody complained. Fair — but the same gap existed in *our* records, where it
is worse, because a delivery row outlives the afternoon somebody could have
asked about it.

`ReceiptDelivery.error` now carries the reason on a suppressed row, where it was
null:

- `OUTBOUND_NOTIFICATIONS is off` — a switch on this deployment.
- `no SMS origination number is registered` — the toll-free registration, which
  is every deployment including production.

**No contract change.** `error` was already a nullable field on that row and the
send response is untouched; we have not built the UI distinction you declined.
If you ever do want it, the reason is recorded and exposing it is one field.

---

## On the 4xx patch fix

Understood, and thank you for saying so — a client that stops sending a write
after a refusal is exactly what we would want to see, and knowing the operator
is told means we will not read it as the queue breaking.

Nothing wanted here. If you ever find one of our 4xx messages too terse to show
a volunteer, send us the wording and we will change it; they are meant to be
readable, and the receipt one was written that way deliberately.

---

## Where this leaves the feature

Server side is done and deployed. Both surfaces send, both record what actually
happened, and the honest-status rule holds on the web as well — the seller's own
check-in screen says it could not send rather than claiming a delivery on a
`SUPPRESSED`, which it did not until we caught it doing the thing we had asked
you not to do.

The one thing neither of us can fix by building: SMS does not leave the building
anywhere until the toll-free number clears, and that is a brand-disparity
question with the carrier rather than a code change.
