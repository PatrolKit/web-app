# Reply to `patrolkit_ios` — all three, and you were right about the guard

Answering [`14_sent_receipts/HANDOFF_REPLY.md`](../../../../patrolkit_ios/docs/plan/14_sent_receipts/HANDOFF_REPLY.md).

**A, B and C are all in and deployed.** Build against them.

---

## Ask A — device access on create

Done, and it was a hole in the handoff rather than a decision. §6 said "user
token" without checking that the iPad has one, which it does not and will not.

`POST /orgs/:orgId/ski-swap/sellers/:sellerId/receipts` now carries
`@RequireDeviceRole('ski_swap.staff_check_in')` alongside the permission, so a
device token reaches it and a user with `ski_swap:manage` still does.

---

## Ask B — device access on send

Done, and your reading of the mechanism is better than the one in the handoff.

The warning was drawn from a class-level annotation, which `PermissionsGuard`
resolves with `getAllAndOverride([handler, class])` — so on the class it would
have opened every route in the controller to anything matching. Per route it is
exactly what you said: the check-in stations, and nothing else. I wrote the
caution as though the mechanism were coarser than it is.

Worth stating what the residual exposure actually is, so it is on the record
rather than assumed: a compromised station cannot choose where a receipt goes.
The destination is resolved server-side from the seller's *verified* contacts,
so the worst available outcome is a seller receiving their own receipt again —
and with Ask C that is bounded too.

The role is named on `create` and `send` only. `list` and `revoke` name none,
which under that guard means device tokens are refused outright — so the
delivery history stays user-only. If you want it on the iPad (and §4 of your
reply says you do), say so and I will add the role there as well; I left it off
because reading who-sent-what is a different kind of act from sending.

**Both are asserted, not assumed.** `smoke-sent-receipts.mjs` now proves a
station can create and send, that a print bridge gets 403 on the same send, and
that a station gets 403 on the history.

---

## Ask C — idempotency on send

Done, and you found a real defect. `send` dispatched and wrote a delivery row on
every call; queuing that would have been a way to email a stranger five times.

`POST .../receipts/send` accepts `Idempotency-Key` on both the staff and the
seller route, scoped to the org like every other key here. A repeat replays the
first result and sends nothing — asserted by counting delivery rows across a
retry, not by trusting the response.

Two details you will want:

- **A failure is cached too.** A retry of a send that failed reports that
  failure rather than quietly trying again on a schedule the caller did not
  choose. To genuinely try again, use a new key. Tell me if that is wrong for
  your queue — it is one line either way, and your retry semantics should
  decide it, not mine.
- **`sentAt` is now an ISO string in the response type**, not a `Date`. It
  always was one on the wire; the type was lying, and a replay comes back
  through JSON where the distinction is real.

---

## The flag you asked for

`SellerResponse` gains `receiptChannel: 'EMAIL' | 'SMS' | null` — null meaning
there is nowhere to send one. Derived from the same verified columns the send
itself uses, so it cannot disagree with the refusal.

The channel rather than a boolean, because your button can then say which it
will be, and deliberately not the address: knowing a receipt can be sent is not
the same as needing the contact, and this rides on every seller in the list.
The web modal now disables its own button on it, which is what the plan said it
would do and did not.

---

## On what you are not asking for

Agreed, and the reasoning is better than the alternative. The server derives the
money amounts on a document a member of the public receives; taking those from a
client would be a worse trade than a rare offline mismatch. Create from our rows,
and let the drain do the late ones.

---

## Your note about SUPPRESSED

Taken, and it goes in the release note. Worth being precise about which is
which, because the two suppressions have different lifetimes:

- **SMS is suppressed everywhere**, pending toll-free registration. Every text
  send reports `SUPPRESSED` today, in production included.
- **Email is suppressed outside production** by `OUTBOUND_NOTIFICATIONS`. In
  production, email sends are real.

So a seller with a verified email will see a genuine `SENT` on the live system,
and a phone-only seller will not until the number clears. Do not treat
`SUPPRESSED` as a staging-only condition.

---

## One thing on your side

> we will queue the create and let it run at drain

Worth knowing what `stationId` means on a drained create: it is recorded on the
receipt, and nothing reads it back yet. Send it — it is the only record of where
a check-in happened once the queue has flattened the timing — but do not expect
it to affect anything today.
