# Server handoff — receipts are a record now, not just a print

A receipt used to be a raster that went to a printer. It is now a row: frozen at
the moment of the check-in, with its own link, and sendable by email or text
afterwards.

**The change iOS has to make is that it creates the record rather than only
printing.** Everything else here is optional.

Server side is live on `develop`. All endpoints below are implemented and covered
by `apps/api/scripts/smoke-sent-receipts.mjs`.

---

## 1. Why this lands on iOS at all

The iPad prints its own receipts and nothing reaches the server. Once a receipt
is a record, that leaves two things broken:

- A seller checked in on iOS walks away with paper the server has never heard
  of. They cannot be sent a copy of it, because it does not exist.
- The staff **Send receipt** button then mints a *fresh* snapshot hours later —
  of whatever the items look like by then, not of what the seller was handed.

So wherever iOS prints a receipt, it should first create the record and print
from what comes back. The server is where a receipt exists; a printer is one way
of rendering one.

---

## 2. Create the record

```
POST /orgs/:orgId/ski-swap/sellers/:sellerId/receipts
Authorization: Bearer <staff token>
Content-Type: application/json

{ "swapId": "...", "stationId": "..." }      // stationId optional
```

`stationId` records where the check-in happened. Send it when the iPad knows its
station; omit it otherwise.

**Response** — the frozen receipt, which is what to print from:

```json
{
  "id": "lsmx7jwz0klelblt7eqi672w",
  "token": "Xk3pQ9vR2mT8nL5wZ7yB4cD6fH1jK0sA",
  "orgName": "Stowe Patrol",
  "orgLogoUrl": null,
  "swapTitle": "Fall Swap",
  "sellerName": "Dana Reyes",
  "payoutLabel": "Check",
  "totalCents": 13500,
  "itemCount": 2,
  "createdAt": "2026-09-17T13:42:00.000Z",
  "logoImageUrl": null,
  "url": "https://skiswap.patrolkit.io/r/Xk3pQ9vR2mT8nL5wZ7yB4cD6fH1jK0sA",
  "trackUrl": "https://skiswap.patrolkit.io/s/q6nn54sqqzohao2ov4ftlo7o",
  "lines": [
    { "name": "Rossignol 172cm Red Skis", "sku": "RCP-R-0001", "priceCents": 4500 },
    { "name": "Snowboard", "sku": "RCP-R-0002", "priceCents": 9000 }
  ]
}
```

**Retrying is safe.** A second call with the same items returns the same receipt
rather than a second one — the server compares the lines, not a timestamp. So a
dropped response can simply be retried, and a re-print of an unchanged check-in
does not mint a duplicate with a different link. If items *have* changed since,
you get a new receipt, which is correct: the old one no longer describes what the
seller has.

That also means **create is the right call before every print**, not only the
first.

### Ordering

Create before printing, and print from the response. If the call fails, printing
from local state is still better than not printing — but the record is what makes
a copy sendable later, so a failure is worth retrying rather than swallowing.

---

## 3. Send a copy

```
POST /orgs/:orgId/ski-swap/sellers/:sellerId/receipts/send
Idempotency-Key: <a key of your choosing>      // optional, but send one
{ "swapId": "..." }
```

**Send the key.** A send is the one write here that is not idempotent by nature:
without a key, every call is another message in somebody's inbox. With one, a
repeat replays the first result and sends nothing — including when the first
attempt failed, so a genuine retry needs a new key.

```json
{
  "receiptId": "...",
  "channel": "EMAIL",
  "destination": "dana@example.com",
  "status": "SUPPRESSED",
  "sentAt": "2026-09-17T13:42:05.000Z",
  "url": "https://skiswap.patrolkit.io/r/DlpTS..."
}
```

The server picks the channel: a verified email if the seller has one, otherwise a
verified phone by SMS. **Unverified contacts are never used** — `email` and
`phone` on a user are claims and may be somebody else's; only `verifiedEmail` and
`verifiedPhone` have been proved.

**`status` matters.** Only `SENT` means a message left the building.

| | |
|---|---|
| `SENT` | Delivered to the provider. Say "Sent to dana@example.com". |
| `SUPPRESSED` | Outbound messaging is switched off on this deployment. Nothing was sent. **Do not report this as delivered.** |
| `FAILED` | The provider refused it. The row is recorded; the message did not go. |

`SUPPRESSED` is the normal state outside production, and SMS is still suppressed
everywhere pending toll-free registration — so expect it while testing and make
sure the UI does not claim a delivery on it.

### No verified contact

```
400  { "success": false, "error": "This seller has no verified email or phone, so there is nowhere to send a receipt." }
```

That sentence is written to be shown to a volunteer. Render it rather than a
generic failure — it says what is missing, which is the only thing that can fix
it. Better still, disable the button when the seller has neither contact.

---

## 4. Optional: what has already gone out

```
GET /orgs/:orgId/ski-swap/sellers/:sellerId/receipts?swapId=...
```

Returns the seller's receipts newest first, each with its deliveries:

```json
[{
  "id": "...",
  "createdAt": "...",
  "itemCount": 2,
  "totalCents": 13500,
  "revokedAt": null,
  "url": "https://.../r/...",
  "deliveries": [{
    "channel": "EMAIL",
    "destination": "dana@example.com",
    "status": "SUPPRESSED",
    "error": null,
    "createdAt": "..."
  }]
}]
```

The web sellers list uses this for a "Last sent to … · today 9:42 AM" line. Worth
copying if the iOS seller screen has room; skippable for a first pass.

---

## 5. What iOS does not need to know

- **Tokens.** The link comes back as `url`. Never construct one — the token is
  random and is the credential for a public page.
- **Templates.** The email body and the SMS text are rendered server-side from
  the same data the public page uses, so paper, email and web cannot disagree
  about what somebody dropped off.
- **Revocation.** A staff-only web action for now.

---

## 6. Permissions

`create` and `send` take either a user token with `ski_swap:manage` or a device
token whose role is `ski_swap.staff_check_in`. `list` and `revoke` are user-only.

> **Corrected.** This section first said user-token only, on the reasoning that
> anything a device can reach every provisioned device can reach. That is true
> of a *class-level* `@RequireDeviceRole` — `PermissionsGuard` resolves it with
> `getAllAndOverride([handler, class])` — but not of one named per route, which
> admits exactly the check-in stations. The iPad has no user token and no way to
> get one, so as first written the one change §1 asks for was impossible. See
> `HANDOFF_REPLY_2.md`.

---

## 7. Questions we did not answer for you

- **Where in the iOS flow the create call goes.** Anywhere before the print, as
  long as the items are final.
- **Whether iOS should offer Send at all**, or only create. Create is the part
  that matters; Send is a convenience the web already has.
- **Offline.** If the iPad prints while offline, the record does not exist yet.
  Creating it on reconnect still works — but the snapshot will be of the items as
  they are *then*. **Answered:** iOS declined a client `createdAt` and declined
  sending us the lines, on the grounds that the server should keep deriving the
  amounts on a document a member of the public receives. Agreed; nothing to
  build.
