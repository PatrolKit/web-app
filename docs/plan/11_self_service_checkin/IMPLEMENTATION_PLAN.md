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
3. They sign in — or sign up — with an email or phone number, proving it with a texted
   code or an emailed link.
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
| Seller portal UI (`ski-swap/my-items`) | Exists — a desktop catalogue tool, *not* the check-in surface (§8) |
| Label layout and rasterisation | Exists, but **in the browser** — §4 |
| Device auth (`clientId`/secret → JWT) | Done — reused for printers |
| Print queue | **Does not exist** — §6 |

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
| **D6b** | **Check-in is a phone-first flow, not a responsive desktop one.** It is designed against a one-handed seller holding a ski, on venue wifi, in Safari. | Every seller arrives with a phone and nothing else — there is no desktop fallback to degrade to. Treating mobile as the target rather than a breakpoint is the difference between a flow that works at a counter and one that technically renders. |
| **D6c** | **Sign-in carries its context on the challenge record.** `/auth/login` accepts a structured `context`; it is stored on `ContactChallenge` and returned by confirm. | An emailed link opens a *new* browser context. The seller scanned the station QR in one tab, and tapping a link in Mail lands them in another with no `swap` or `printer` — signed in, standing at a printer, with no idea which one. Storing the context on the record means the new tab can ask the server what this sign-in was *for*, so nothing depends on which tab the person ends up in. |
| **D6d** | **The context is structured data the server interprets — never a URL, and never read from the query string.** `{swapId, printerId}`, validated against each other. | Two failure modes, both avoided by the same rule. A free-form `returnTo` makes every sign-in link an open redirect: a genuine link that authenticates you and *then* bounces you to a lookalike. And a printer id read from the URL is attacker-controlled — edit the address bar, print someone else's tags on your station. |
| **D6e** | **Each channel keeps the shape it is good at**: SMS sends a code, email sends a link. | With context solved, uniformity buys nothing. On iOS an input marked `autocomplete="one-time-code"` offers the SMS code in the keyboard bar the moment it arrives — one tap, no app switch. Email has no such affordance, so a code there means reading six digits, switching apps, and typing them correctly; a link is one tap and cannot be mistyped. |
| **D6f** | **Confirmation requires a tap, not a page load.** The verify screen presents a button rather than firing on mount. | Challenges are single-use. `VerifyPage` currently confirms inside a `useEffect`, so anything that loads the URL before the human does spends the token and the seller sees "invalid or expired". Mail security scanners do prefetch links; most do not run JavaScript, which is the only reason this is not already biting. Leaning harder on links makes that margin too thin to rely on. |
| **D7** | **Check-in mints a normal session.** No special "check-in token". The seller signs in exactly as they would anywhere else, and the QR only supplies context. | Plan 10 D8 — verification and login are the same act. A second, weaker credential path is how the first one gets bypassed. |
| **D8** | **The station is a property of the session, not of the person.** `swapId` and `printerId` live in the client and, for the span of a sign-in, on the challenge (D6c) — never on `SellerProfile`. | A seller may check in at one station this year and another next. Persisting it on the person would make a transient fact permanent, and would quietly become wrong the first time someone moves stations mid-swap. |

---

## 3. Flow

```
   ┌─ station QR: /checkin?swap=<swapId>&printer=<printerId>
   │
   ├─ 1. GET /public/checkin/:swapId  ──▶ org name, logo, swap title, printer label
   │       (validates swap is active and printer belongs to the same org)
   │
   ├─ 2. person enters email OR phone
   │       └─ POST /auth/login  { email|phone, context: { swapId, printerId } }
   │            └─ context stored on the challenge (D6c), validated first (D6d)
   │            └─ no match? sign-up form (first, last, email, phone, address)
   │                 └─ POST /public/checkin/:swapId/register  ──▶ challengeId
   │
   ├─ 3. SMS → a 6-digit code, autofilled into this tab
   │    email → a link, which opens a NEW tab (D6e)
   │       └─ POST /auth/challenges/:id/confirm
   │            ──▶ { accessToken, context: { swapId, printerId } }
   │            └─ either tab can now resume: the station came back from the server,
   │               not from whichever tab happened to survive
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

Step 2 reuses `/auth/login` with one added `context`; step 3 is the existing confirm,
returning that context alongside the session. Step 5 is the existing item
endpoint with one added optional field. The genuinely new surface is a public context
lookup, a registration entry point, a join, a reprint, and a finish.

**The seller is standing at the printer waiting**, which makes this the one place latency
is a product requirement rather than a nicety: from tapping Save to paper moving should
stay inside a couple of seconds. §6 sizes the polling interval against that.

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

## 5. Sign-in context

`ContactChallenge` gains one nullable column:

```prisma
  /// What this sign-in was for, so the session can resume it whichever browser
  /// context confirms. Structured and server-interpreted — never a URL (D6d).
  /// { swapId, printerId } today; other flows may add their own shapes.
  context Json?
```

Three rules keep it safe:

- **Validated at issue, not at use.** `swapId` must name an active swap, and `printerId`
  a printer in that swap's org. A challenge that stored an invalid pairing would fail
  later, in the new tab, where there is no good way to recover.
- **Returned, never redirected to.** Confirm hands back `{ swapId, printerId }` and the
  client decides what to render. The server never issues a redirect from stored context,
  which is what keeps this from becoming an open redirect.
- **Scoped to the challenge.** It lives and dies with the row, and is gone once the
  challenge is used or expires. Nothing about a station persists on the person (D8).

This is deliberately generic. The immediate need is check-in, but any flow that has to
survive a sign-in — deep-linking to an item, claiming a seller page from a printed QR —
uses the same column rather than inventing its own workaround.

## 6. The print queue

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

## 7. API surface

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

- `POST /auth/login` gains an optional structured `context` (§5), validated at issue and
  stored on the challenge.
- `POST /auth/challenges/:id/confirm` returns that `context` alongside the session, so a
  browser context that did not start the sign-in can still resume it.
- `POST /orgs/:orgId/ski-swap/seller/me/items` gains an optional `printerId`. When
  present, the created item's tags are enqueued to that printer; when absent the endpoint
  behaves exactly as it does today.
- `SwapPrinter` responses gain `deviceId`, `lastSeenAt`, `queueDepth`.
- `DEVICE_ROLES` gains `Ski Swap - Printer`.
- Browser printing fetches rasters from the server instead of rendering locally.

---

## 8. Web work

### The check-in flow is its own surface

`BusinessSellerPage` is **not** the check-in UI. It is a desktop portal for a business
seller managing a catalogue from an office, and retrofitting it into a one-handed venue
flow would serve neither well. Check-in gets purpose-built screens under `/checkin`, and
the two share the API and nothing else.

- **`/checkin`** — the QR destination. Reads `swap` and `printer` from the query string and
  holds them for the whole session, and can also recover them from a confirm response when
  an emailed link lands the seller in a fresh tab (D6c). Walks: context →
  sign in or register → code → join → add items → finish.
- **Item entry is the screen that matters.** One item at a time, one column, thumb-reachable
  primary action. Printing has to be visible: which item is printing, whether the tag came
  out, and a one-tap reprint when it did not.
- **`VerifyPage` gains a confirm button.** Today it fires `confirmChallenge` from a
  `useEffect` on mount; a single-use token deserves a deliberate tap, not a page load
  (D6f). It also reads the returned `context` and routes into check-in when one is present.
- **Fix the seller redirect** — derive from `membership.roles.includes('seller')` rather
  than the retired `business_seller` permission (§1).
- **Station queue view** for staff, off the printers tab: depth, last-seen, failures, retry.

### What phone-first actually means here

Not a breakpoint. These are the constraints that change the design:

- **Cold start in Safari.** The iOS camera app opens QR links in a fresh tab, so `/checkin`
  must work unauthenticated, with no prior state, from a link alone.
- **The keyboard eats the viewport.** Item entry has to stay usable in roughly 300px of
  visible height, which rules out tall forms and fixed footers that end up behind the
  keyboard.
- **Inputs must not zoom.** iOS Safari zooms any focused input below 16px, and once zoomed
  the layout is wrong for the rest of the session.
- **The right keyboard per field.** `inputMode="decimal"` for price, `type="tel"` for
  phone, `autocomplete` on the sign-up fields — a seller holding a ski should not be
  hunting for the number key.
- **`autocomplete="one-time-code"` on the SMS code input.** This is what makes the texted
  code a single tap on iOS rather than six keystrokes, and it is the entire reason D6e
  keeps SMS on codes.
- **Photos come from the camera**, via `capture="environment"`, and are downscaled in the
  browser before upload. A modern phone photo is several megabytes and venue wifi is not.
- **`100vh` is a lie on iOS.** Use `100dvh` and respect `env(safe-area-inset-*)`, or the
  primary action sits under the home indicator.
- **The session must survive backgrounding.** Taking a photo suspends the tab; coming back
  must not mean signing in again.

### Verification

Responsive CSS is not evidence. Phase 5 is verified on a real phone-sized viewport with
touch emulation, walking the whole flow, plus at least one pass on physical iOS hardware
before a swap — the `100dvh`, zoom, and camera behaviours above are all ones the desktop
browser will happily lie about.

---

## 9. Work breakdown

**Phase 1 — Server-side rendering.** Port layout to `@napi-rs/canvas`; move rasteriser and
ESC/POS verbatim; golden-image fixtures. No behaviour change yet — nothing calls it.

**Phase 2 — Browser renders via the server.** Point the Bluetooth path at the new
endpoint; strip layout from `PhomemoPrinterService`, leaving transport. Two renderers
become one, before firmware exists.

**Phase 3 — Queue.** `PrintJob`, `SwapPrinter.deviceId`, the atomic claim, the three
device endpoints, the `Ski Swap - Printer` role. Testable end to end with a fake device —
no hardware needed.

**Phase 4 — Sign-in context.** `ContactChallenge.context`, plumbed through login and
confirm, with issue-time validation. Convert `VerifyPage` to tap-to-confirm (D6f). Small,
and independently useful — it is what lets any flow survive a sign-in.

**Phase 5 — Check-in.** `PublicCheckinService`, register, join. Wire save-time enqueue into
item creation, plus reprint and finish. Fix the seller redirect.

**Phase 6 — Web.** Purpose-built `/checkin` screens, station queue view. Verified on a
phone viewport and on physical iOS.

**Phase 7 — Hardening.** Reaping under load, queue-depth alerting, abandoned-job
visibility, and a documented recovery path for "the printer died mid-swap".

---

## 10. Accepted costs

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
  rather than a background one — which is why §7 exposes queue depth and last-seen to
  staff.
- **No approval gate (D5)** means a mistyped price goes live immediately. Staff can edit
  after the fact, and the tag is the artefact that matters physically.
- **The seller needs working connectivity at the venue.** Lodge wifi is not a given, and
  the flow has no offline mode: a dropped connection mid-entry loses the item being typed.
  This is the single most likely way check-in fails in the real world, and it is worth
  measuring signal at the actual venue before the first swap rather than discovering it
  with a queue of people.
- **`ContactChallenge` gains a `Json` context column.** A generic escape hatch on a
  security-sensitive record. D6d's rules — structured only, validated at issue, returned
  rather than redirected to — are what keep it from drifting into a `returnTo` field, and
  they need holding on review.
- **An emailed link still means leaving the browser.** D6e accepts that: the seller taps a
  notification, Mail opens, they tap once more and land back in Safari. Fewer steps than
  transcribing six digits, but more than the SMS path, and it depends on their mail app
  behaving. Sellers who pick SMS get the better flow, and the UI can nudge that way.

## 11. Open questions

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
4. **Should the check-in screen prefer phone over email?** D6e makes SMS materially
   smoother — autofilled code, never leaves the tab — while email costs an app switch.
   Offering both equally is honest; leading with phone is faster. That is a copy and
   layout decision, not an architectural one, but it wants making deliberately.
5. **Should item entry survive a dropped connection?** A local draft of the in-progress
   item, replayed when the network returns, would cover the most likely venue failure. It
   is real work and real state to reconcile, so it is deliberately not in this plan — but
   if the connectivity measurement above comes back poor, it moves from optional to
   required.
6. **What stops a seller from walking off mid-check-in?** Items exist and tags are printed
   and stuck on gear that never reaches the floor. Staff need a way to see checked-in
   sellers who never finished — a station view of in-progress check-ins would cover both
   this and question 3.
