# Plan 11 — Self-Service Check-In

> **Status:** Draft v1 — for review.
> **Depends on:** [Plan 10](../10_user%20consolidation/IMPLEMENTATION_PLAN.md). The identity
> half of this flow — `ContactChallenge`, two-channel login, `PersonService` matching,
> `SellerProfile` — already exists and is deployed.
> **Out of scope:** ESP-32 firmware. This plan defines the contract that firmware
> implements and builds everything on the server side of it.

---

## 1. What we are building

A seller arrives at the venue with a box of gear. Today they queue at a counter while
staff type their name, phone and address, then dictate every item. Instead:

1. They are directed to a **station**, each with its own printer.
2. They scan the station's **QR code** with their own phone. It identifies the swap and
   the station's printer.
3. They sign in — or sign up — with an email or phone number, proving it with a code.
4. They enter their own items on their own phone. **Each item's tags print as it is
   saved**, on that station's printer.
5. They collect each tag as it emerges and stick it on the item themselves.
6. When they are done, staff verify the tagged pile against the seller's list and take
   the goods.

Staff stop being typists and go back to handling gear.

### What already exists

| Piece | State |
|---|---|
| Identity, matching, verified contacts | Done (Plan 10) |
| Two-channel login + `ContactChallenge` | Done (Plan 10) |
| Seller item CRUD, photos (`seller/me/items`) | Done — reused wholesale |
| Seller portal UI (`ski-swap/my-items`) | Exists; needs a mobile pass |
| Label layout and rasterisation | Exists, but **in the browser** — §4 |
| Device auth (`clientId`/secret → JWT) | Done — reused for printers |
| Print queue | **Does not exist** — §5 |

### Two defects this plan fixes

- **`PublicCheckinService` was never built.** Plan 10 lists it in §9, §10 and Phase 3, and
  that plan is marked implemented. The endpoint does not exist. This plan is where it
  gets built.
- **Sellers cannot reach their own portal.** [`App.tsx:42`](../../apps/web/src/App.tsx)
  routes on `perms.has('business_seller')`, a permission Plan 10 retired (D12), so the
  redirect can never fire and a signed-in seller lands on the members page. The
  destination this whole flow delivers people to is currently unreachable.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **The QR carries `swapId` and `printerId`.** Org is derived from the swap, not encoded separately. | One less thing to keep consistent. A swap belongs to exactly one org, so encoding both invites them to disagree. |
| **D2** | **The server renders labels; the queue carries bytes.** A job payload is a finished 1-bit raster. Firmware claims a job, writes it to the print head, acks. | Label design churns — `add_printer_margins` and `update_default_margins` landed days apart. Under firmware rendering every margin tweak is a firmware rollout to hardware in a lodge. It also avoids two renderers (TypeScript canvas, C++ firmware) expected to produce identical output; they would drift, and drift shows up as tags that do not scan. |
| **D3** | **Printers are registered devices** with a new `Ski Swap - Printer` role, using the existing `clientId`/secret → JWT flow. | Device auth already exists, is tested, and already scopes to an org. A printer is just another device. |
| **D4** | **At-least-once delivery**, with claim → ack and a visibility timeout that returns unacked jobs to the queue. | A duplicate tag costs a strip of paper. A lost tag costs a seller their item. The asymmetry is not close. |
| **D5** | **Self-entered items go live immediately** — no staff approval gate. | Staff verify the physical pile at handover, which is the check that actually matters. An approval queue would recreate the bottleneck this removes. |
| **D5b** | **Tags are enqueued when an item is saved**, not in a batch at the end. Saving is the print trigger. | The seller applies tags themselves, item by item, while the gear is in front of them. Batching would hand someone a stack of tags and a pile of gear and ask them to re-match the two. |
| **D5c** | **An item prints once.** Editing a saved item does not reprint; `hasPrintedTag` guards it. Reprints are an explicit action. | A seller correcting a typo has already stuck the tag on. Silent reprinting produces a second tag with no home. |
| **D6** | **`SwapPrinter` gains a device link rather than being replaced.** A printer row is Bluetooth-driven, device-driven, or both. | The Bluetooth path has to keep working while ESP-32 hardware is built and rolled out. |
| **D7** | **Check-in mints a normal session.** No special "check-in token". The seller signs in exactly as they would anywhere else, and the QR only supplies context. | Plan 10 D8 — verification and login are the same act. A second, weaker credential path is how the first one gets bypassed. |
| **D8** | **The station is a property of the session, not of the person.** `swapId` and `printerId` ride in the client, not on `SellerProfile`. | A seller may check in at one station this year and another next year. Persisting it would make a transient fact permanent. |

---

## 3. Flow

```
   ┌─ station QR: /checkin?swap=<swapId>&printer=<printerId>
   │
   ├─ 1. GET /public/checkin/:swapId  ──▶ org name, logo, swap title, printer label
   │       (validates swap is active and printer belongs to the same org)
   │
   ├─ 2. person enters email OR phone
   │       └─ POST /auth/login          ──▶ challengeId  (existing endpoint, unchanged)
   │            └─ no match? sign-up form (first, last, email, phone, address)
   │                 └─ POST /public/checkin/:swapId/register  ──▶ challengeId
   │
   ├─ 3. code arrives by email or SMS
   │       └─ POST /auth/challenges/:id/confirm  ──▶ session  (existing, unchanged)
   │            └─ contact stamped verified; this is the one flow where the contact
   │               is self-entered and therefore trustworthy
   │
   ├─ 4. POST /orgs/:orgId/ski-swap/checkin/join   { swapId }
   │       └─ upsert membership + SellerProfile (individual)
   │
   ├─ 5. for each item:
   │       POST /orgs/:orgId/ski-swap/seller/me/items  { ..., printerId }
   │         └─ item created, then labelsPerItem tags enqueued for it
   │              └─ ESP-32 claims, prints, acks  ──▶ seller peels tag, sticks it on
   │       (mis-stick or jam → POST .../items/:itemId/reprint)
   │
   └─ 6. POST /orgs/:orgId/ski-swap/checkin/finish  { swapId, printerId }
           └─ enqueue the seller's summary receipt — the sheet staff verify the
              physical pile against at handover
```

Steps 2 and 3 are **existing endpoints reused unchanged**. Step 5 is the existing item
endpoint with one added optional field. The genuinely new surface is a public context
lookup, a registration entry point, a join, a reprint, and a finish.

**The seller is standing at the printer waiting**, which makes this the one place latency
is a product requirement rather than a nicety: from tapping Save to paper moving should
stay inside a couple of seconds. §5 sizes the polling interval against that.

### Registration is deliberately separate from login

`POST /auth/login` cannot create people — it must stay non-enumerable, and creating an
account for an unknown address would make it an oracle. So an unmatched seller goes
through `/public/checkin/:swapId/register`, which creates the person and issues the same
kind of challenge. The two paths converge at confirm.

Registration is rate-limited per IP and only ever creates an *unverified* person with no
memberships. Until they confirm a code they can do nothing, so an abusive caller can only
manufacture inert rows.

---

## 4. Server-side label rendering

The 867 lines in
[`PhomemoPrinterService.ts`](../../apps/web/src/lib/printing/PhomemoPrinterService.ts)
do layout on a `<canvas>`, `rasterise()` to `boolean[][]`, then wrap in ESC/POS raster
commands at 320 dots wide. This moves to the API.

**Approach:** port the layout to `@napi-rs/canvas` — a prebuilt-binary Skia canvas with
the same 2D API, so the drawing code transfers nearly unchanged, and no native build
toolchain is needed on the EC2 host. The rasteriser and ESC/POS builders are pure
functions over pixel data and move verbatim.

```
apps/api/src/ski-swap/printing/
  label-renderer.service.ts   layout + rasterise  (ported)
  escpos.util.ts              command builders    (moved verbatim)
  label-templates.ts          item / header / QR / calibration
```

**Two renderers is the thing to avoid.** Once the server renders, the browser stops
rendering: the Bluetooth path fetches the same raster from the server and writes it over
Web Bluetooth. `PhomemoPrinterService` keeps only transport — connect, write, disconnect.
That collapses today's two paths into one before the ESP-32 arrives, so the firmware is
not chasing a moving target.

**Golden-image tests.** Rendering has no natural assertion, so the port is verified by
committing reference rasters for a fixed set of inputs and asserting byte equality. Those
same fixtures are what the firmware team tests against.

---

## 5. The print queue

### Schema

```prisma
model PrintJob {
  id        String @id @default(cuid())
  orgId     String
  printerId String
  /// Set when a job belongs to a check-in; null for staff-initiated reprints.
  swapId    String?
  sellerId  String?

  /// item | receipt | qr | calibration — what the payload depicts.
  kind    String
  /// 1-bit raster, run-length encoded. Rendered at enqueue time, so a later
  /// template change never rewrites a job already queued.
  payload Bytes
  /// Ordering within one seller's batch, so tags print in the order entered.
  seq     Int    @default(0)

  /// queued | claimed | printed | failed | abandoned
  status     String    @default("queued")
  claimedAt  DateTime?
  /// Claim expiry. A job past this with status=claimed returns to the queue.
  claimUntil DateTime?
  printedAt  DateTime?
  attempts   Int       @default(0)
  lastError  String?   @db.VarChar(500)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  org     Organization  @relation(fields: [orgId], references: [id], onDelete: Cascade)
  printer SwapPrinter   @relation(fields: [printerId], references: [id], onDelete: Cascade)

  @@index([printerId, status, seq])
  @@index([status, claimUntil])
  @@index([orgId, createdAt])
}
```

`SwapPrinter` gains (D6):

```prisma
  /// Set when this printer is an ESP-32 pulling from the queue rather than a
  /// Bluetooth device driven by a browser.
  deviceId   String?  @unique
  lastSeenAt DateTime?
  device     Device?  @relation(fields: [deviceId], references: [id], onDelete: SetNull)
```

### Firmware contract

Three endpoints, all device-authenticated, all scoped to the calling device's own printer.

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/devices/me/print-jobs/claim` | Atomically claims up to `n` queued jobs for this device's printer, oldest `seq` first. Sets `status=claimed`, `claimUntil=now+90s`, increments `attempts`. Returns `{id, kind, seq, payload}`. Empty array when idle. |
| `POST` | `/devices/me/print-jobs/:id/ack` | `status=printed`. Idempotent — acking a printed job is a no-op, so a retried ack after a dropped response is safe. |
| `POST` | `/devices/me/print-jobs/:id/nack` | `status=queued` and clears the claim, so it retries immediately. Body carries `{error}`. After 5 attempts the job goes to `abandoned` rather than looping. |

**Transport is short polling, at 1 second while a station is active.** An ESP-32 holding a
TLS socket open is the least reliable part of the system, and a poll recovers from a
dropped connection by simply polling again. The interval is a product constraint here, not
a free choice: the seller is standing at the printer waiting for a tag they are about to
stick on a ski, so worst-case pickup latency *is* the poll interval. One request per second
per station is negligible at a dozen stations.

The claim response carries a `backoffMs` the server can raise once a printer's queue has
been empty for a while, so idle stations drop to a slower cadence without a firmware
change. Long-polling can replace this later behind the same contract if a second proves
too slow in practice.

**The claim is a single atomic UPDATE**, not read-then-write:

```sql
UPDATE PrintJob SET status='claimed', claimedAt=NOW(3), claimUntil=NOW(3)+INTERVAL 90 SECOND,
       attempts=attempts+1, claimToken=?
 WHERE printerId=? AND (status='queued' OR (status='claimed' AND claimUntil < NOW(3)))
 ORDER BY seq, createdAt LIMIT ?
```
then select the rows bearing that token. Two printers racing, or one printer whose earlier
claim expired mid-print, cannot both win the same row.

**Reaping.** A sweep marks expired claims back to `queued`. It piggybacks on the claim
query above rather than running as a separate scheduled task, so an idle system does no
work and a busy one self-heals.

### Enqueue

Enqueueing hangs off **item creation**, not a batch action (D5b). `POST
/orgs/:orgId/ski-swap/seller/me/items` gains one optional field, `printerId`; when present
the service renders and enqueues `labelsPerItem` tags for the item it just created, in the
same request. Absent — the desktop portal, a business seller working from home — nothing
prints and the endpoint behaves exactly as it does today. One code path, one added branch.

`hasPrintedTag` already exists on `SwapItem` and becomes the guard: set when the jobs are
enqueued, and a later edit does not re-enqueue (D5c). That flag is also what makes the
request safe to retry — a create whose response was lost will not double-print, because
the retry either creates a fresh item or finds the flag already set.

**Reprints are explicit.** `POST .../items/:itemId/reprint { printerId }` re-enqueues one
item — the answer to a jam, a mis-stick, or a tag that came out unreadable. It is the only
path that deliberately prints an item twice.

**Finish prints the summary.** `POST /orgs/:orgId/ski-swap/checkin/finish` enqueues a
a `receipt` job summarising the seller's items for this swap. That sheet is what staff
check the physical pile against at handover, so it is generated at the end when the list
is final — not at the start, when it would be empty.

---

## 6. API surface

### New — public

- `GET /public/checkin/:swapId` — org name, logo, swap title, printer label. Validates the
  swap is active and the printer belongs to the same org. Throttled.
- `POST /public/checkin/:swapId/register` — creates an unverified person and issues a
  challenge. Throttled hard.

### New — seller

- `POST /orgs/:orgId/ski-swap/checkin/join` — upserts membership + individual
  `SellerProfile` for the caller in this org.
- `POST /orgs/:orgId/ski-swap/seller/me/items/:itemId/reprint` — re-enqueues one item's
  tags after a jam or a mis-stick.
- `POST /orgs/:orgId/ski-swap/checkin/finish` — enqueues the seller's summary receipt for
  staff to verify the pile against.

### New — device

- `POST /devices/me/print-jobs/claim`
- `POST /devices/me/print-jobs/:id/ack`
- `POST /devices/me/print-jobs/:id/nack`

### New — staff

- `GET /orgs/:orgId/ski-swap/printers/:printerId/queue` — queue depth, last-seen, failures.
  Staff need to see that a station is stuck without reading logs.
- `POST /orgs/:orgId/ski-swap/printers/:printerId/test` — enqueues a calibration label.

### Changed

- `POST /orgs/:orgId/ski-swap/seller/me/items` gains an optional `printerId`. When
  present, the created item's tags are enqueued to that printer; when absent the endpoint
  behaves exactly as it does today.
- `SwapPrinter` responses gain `deviceId`, `lastSeenAt`, `queueDepth`.
- `DEVICE_ROLES` gains `Ski Swap - Printer`.
- Browser printing fetches rasters from the server instead of rendering locally.

---

## 7. Web work

- **`/checkin` route on the seller site** — the QR destination. Reads `swap` and `printer`
  from the query string, holds them for the session, and walks: context → sign in or
  register → confirm → join → add items → finish. Every item save carries the `printerId`,
  and the UI has to make the printing visible: which item is printing, whether the tag
  came out, and a one-tap reprint when it did not.
- **Mobile pass over the seller portal.** `BusinessSellerPage` is the item-entry surface
  and was built for a desktop. It gets touch targets, a single-column form, and a camera
  capture path for photos.
- **Fix the seller redirect** — derive from `membership.roles.includes('seller')` rather
  than the retired `business_seller` permission (§1).
- **Station queue view** for staff, off the printers tab: depth, last-seen, failures,
  retry.

---

## 8. Work breakdown

**Phase 1 — Server-side rendering.** Port layout to `@napi-rs/canvas`; move rasteriser and
ESC/POS verbatim; golden-image fixtures. No behaviour change yet — nothing calls it.

**Phase 2 — Browser renders via the server.** Point the Bluetooth path at the new
endpoint; strip layout from `PhomemoPrinterService`, leaving transport. Two renderers
become one, before firmware exists.

**Phase 3 — Queue.** `PrintJob`, `SwapPrinter.deviceId`, the atomic claim, the three
device endpoints, the `Ski Swap - Printer` role. Testable end to end with a fake device —
no hardware needed.

**Phase 4 — Check-in.** `PublicCheckinService`, register, join. Wire save-time enqueue into
item creation, plus reprint and finish. Fix the seller redirect.

**Phase 5 — Web.** `/checkin` route, mobile portal pass, station queue view.

**Phase 6 — Hardening.** Reaping under load, queue-depth alerting, abandoned-job
visibility, and a documented recovery path for "the printer died mid-swap".

---

## 9. Accepted costs

- **A rendering dependency in the API.** `@napi-rs/canvas` ships prebuilt binaries, so no
  build toolchain, but it is a native module and pins us to supported platforms.
- **Duplicate tags are possible by construction (D4).** A printer that prints and then
  fails to ack will reprint on retry. Cheap, and the alternative loses tags.
- **Short polling wastes requests when idle.** One request per printer per second while
  active. At a dozen stations this is nothing; it would matter at hundreds, which is what
  `backoffMs` is for.
- **The seller is blocked on the printer.** Save-time printing ties the pace of check-in to
  hardware: a jam or an out-of-paper printer stops that station, where batch printing would
  have let them keep entering items and sort the paper out afterwards. That is the right
  trade for tag-to-item accuracy, but it makes printer health a live operational concern
  rather than a background one — which is why §6 exposes queue depth and last-seen to
  staff.
- **No approval gate (D5)** means a mistyped price goes live immediately. Staff can edit
  after the fact, and the tag is the artefact that matters physically.
- **The seller needs working connectivity at the venue.** Lodge wifi is not a given, and
  the flow has no offline mode. Worth measuring before the first real swap.

## 10. Open questions

1. **Should the station QR expire or rotate?** As drawn it is a static printed code. Anyone
   who photographs it can enqueue jobs to that printer from anywhere, which at worst wastes
   paper — but it is unauthenticated context, and worth a deliberate decision.
2. **Can two sellers use one station at the same time?** This is now the sharpest of these.
   With save-time printing, two people entering items against one printer produce
   interleaved tags, and neither knows which one just came out. The schema assumes one
   printer per station; whether it also assumes *one seller at a time* is a floor-plan
   decision that changes the UI (a station could show "now printing: Jane's Rossignol
   skis") or the hardware count.
3. **What does the finish receipt contain?** It exists to let staff verify a physical pile
   against a list, so it probably wants every item and a count — more than
   `generateReceiptHeaderLabel` prints today. Worth designing against the actual handover
   conversation.
4. **What stops a seller from walking off mid-check-in?** Items exist and tags are printed
   and stuck on gear that never reaches the floor. Staff need a way to see checked-in
   sellers who never finished — a station view of in-progress check-ins would cover both
   this and question 3.
