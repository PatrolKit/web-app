# Plan 11 — Self-Service Check-In

> **Status:** Draft — for review.
> **Depends on:** [Plan 10](../10_user%20consolidation/IMPLEMENTATION_PLAN.md). The identity
> half of this flow — `ContactChallenge`, two-channel login, `PersonService` matching,
> `SellerProfile` — already exists and is deployed.
> **Out of scope:** ESP-32 firmware. This plan defines the contract firmware implements and
> builds everything on the server side of it.

---

## 1. What we are building

A seller arrives at the venue with a box of gear. Today they queue at a counter while staff
type their name, phone and address, then dictate every item. Instead:

1. They are directed to a **station**, each with its own printer.
2. They scan the station's **QR code** with their own phone. It identifies the swap and the
   station's printer.
3. They sign in — or sign up — with an email or phone number, proving it with a texted code
   or an emailed link.
4. They enter their own items. **Each item's tags print as it is saved**, on that station's
   printer.
5. They collect each tag as it emerges and stick it on the item themselves.
6. When they are done, staff verify the tagged pile against a printed receipt and take the
   goods.

Staff stop being typists and go back to handling gear.

### What already exists

| Piece | State |
|---|---|
| Identity, matching, verified contacts | Done (Plan 10) |
| Two-channel login + `ContactChallenge` | Done (Plan 10) |
| Seller item CRUD, photos (`seller/me/items`) | Done — reused wholesale |
| Label layout, rasterisation, receipt pagination | Exists, but **in the browser** (§4) |
| Device auth (`clientId`/secret → JWT) | Done — reused for printers |
| Seller portal UI (`ski-swap/my-items`) | A desktop catalogue tool on the admin host — *not* the check-in surface (§10) |
| Print queue | **Does not exist** (§8) |

### Defects this plan fixes

- **`PublicCheckinService` was never built.** Plan 10 lists it in §9, §10 and Phase 3, and
  that plan is marked implemented. The endpoint does not exist.
- **Sellers cannot reach their own portal.** [`App.tsx:42`](../../apps/web/src/App.tsx)
  routes on `perms.has('business_seller')`, a permission Plan 10 retired, so the redirect
  can never fire and a signed-in seller lands on the members page. The destination this
  flow delivers people to is currently unreachable.

### One it records but does not fix

**iOS and the web disagree on print-head width.** The web is correct — 400 dots, which is
what prints across 50 mm media on the M110. iOS still reports a 304-dot printable area and
describes the 400-wide case as a separate "50 mm printer", leftovers from when 40×30 was
the only paper. iOS is a separate repo already slated for update; the server renderer must
adopt the web's geometry, and the two should be reconciled when iOS is next touched (§4).

---

## 2. Decisions

### The flow

| # | Decision | Rationale |
|---|---|---|
| **D1** | **The QR carries `swapId` and `printerId`.** Org is derived from the swap. | A swap belongs to exactly one org, so encoding both invites them to disagree. |
| **D2** | **Check-in is hosted on the seller site**, at `skiswap.patrolkit.io/checkin`. | It is a seller-facing surface, and that host is where seller-facing surfaces live. It also keeps members of the public off the admin domain, where every other route is staff tooling. |
| **D3** | **Phone-first, not a responsive desktop page.** Designed against a one-handed seller holding a ski, on venue wifi, in Safari. | Every seller arrives with a phone and nothing else — there is no desktop fallback to degrade to. |
| **D4** | **Check-in mints a normal session.** No special "check-in token"; the QR only supplies context. | Plan 10 D8 — verification and login are the same act. A second, weaker credential path is how the first gets bypassed. |
| **D5** | **The station belongs to the session, and is never recorded anywhere.** `swapId` and `printerId` live in the client and, for the span of a sign-in, on the challenge. Nothing persists which seller is at which station. | A seller may check in at one station this year and another next, so persisting it would make a transient fact permanent. Recording it *transiently* was considered and dropped: an exclusive claim is remotely seizable — anyone with a photo of the QR could lock out the person standing at the station — and a non-exclusive one is a label nobody reads, always slightly stale, telling staff something they can see by looking up. One seller per station is a floor-plan matter, and when it goes wrong the item description on the tag is what sorts it out. |
| **D6** | **No staff approval gate.** Self-entered items go live immediately. | Staff verify the physical pile at handover, which is the check that matters. An approval queue would recreate the bottleneck this removes. |

### Printing

| # | Decision | Rationale |
|---|---|---|
| **D7** | **The server renders labels; the queue carries bytes.** A job payload is a finished 1-bit raster. Firmware claims, writes to the head, acks. | Label design churns — `add_printer_margins` and `update_default_margins` landed days apart, and each would be a firmware rollout to hardware in a lodge. It also avoids a third renderer: the two that exist have **already** drifted on head width (§4), and drift shows up as tags that do not scan. |
| **D8** | **Printers are registered devices** under a new `Ski Swap - Printer` role, using the existing `clientId`/secret → JWT flow. | Device auth already exists, is tested, and scopes to an org. A printer is just another device. |
| **D9** | **`SwapPrinter` gains a device link rather than being replaced.** A printer row is Bluetooth-driven, device-driven, or both. | The Bluetooth path must keep working while ESP-32 hardware is built and rolled out. |
| **D10** | **At-least-once delivery**, claim → ack with a visibility timeout returning unacked jobs to the queue. | A duplicate tag costs a strip of paper. A lost tag costs a seller their item. |
| **D11** | **Tags enqueue when an item is saved**, not in a batch at the end. | The seller applies tags themselves, item by item, while the gear is in front of them. Batching hands someone a stack of labels and a pile of gear and asks them to re-match the two. |
| **D12** | **An item prints once.** Editing does not reprint; the presence of print jobs for the item guards it. Reprints are explicit. | A seller correcting a typo has already stuck the tag on. Silent reprinting produces a second tag with no home. The guard is the queue rather than `hasPrintedTag`, because that flag means *paper came out* (D13) and is still false in the seconds between enqueue and ack — exactly when an edit is most likely. |
| **D13** | **`hasPrintedTag` is set on ack, not on enqueue.** It means a tag physically emerged, and the printer is what reports that. | It is what the field already means — today the browser prints over Bluetooth and then PATCHes it — and the honest state to show a seller who is watching for paper. Setting it at enqueue would claim a tag exists the moment a job is queued, so a jam or an empty roll would leave an item marked printed with nothing stuck to it. |
| **D14** | **The Square push leaves the item-save path**, batched at finish. | Latency, not correctness. `ItemService.create` awaits `syncItemToPos` *and* `fetchInventoryMap` — two Square round-trips on venue wifi, inside an interaction that must stay under a couple of seconds. Phantom inventory is not the argument: an item not on the floor cannot be scanned. |
| **D15** | **SKUs are namespaced by station**: `PREFIX-C-NNNN`, one character of station code, counter per (swap, station). | The pattern iOS already uses, narrowed from three characters to one. It makes a separate self-check-in marker unnecessary — the station code already says where a tag came from — and deletes the shared-counter contention. |
| **D16** | **No two *active* swaps in an org share a SKU prefix.** A mirror column written only while active, with a unique index. | A prefix derived from a title is not naturally unique: "Ski Swap 2026" and "Spring Sale 2026" both derive `SS26`. Scoping to active swaps keeps old prefixes reusable. |

### Sign-in

| # | Decision | Rationale |
|---|---|---|
| **D17** | **Sign-in carries its context on the challenge record.** `/auth/login` accepts a structured `context`, stored on `ContactChallenge` and returned by confirm. | An emailed link opens a *new* browser context. The seller scanned the QR in one tab; tapping a link in Mail lands them in another with no `swap` or `printer` — signed in, standing at a printer, with no idea which one. Storing it on the record means the new tab can ask the server what the sign-in was *for*. |
| **D18** | **The context is structured data the server interprets — never a URL, never read from the query string.** | Two failure modes, one rule. A free-form `returnTo` makes every sign-in link an open redirect. And a printer id read from the URL is attacker-controlled: edit the address bar, print on someone else's station. |
| **D19** | **Each channel keeps the shape it is good at** — SMS a code, email a link — and **check-in leads with phone**. | With context solved, uniformity buys nothing. On iOS an input marked `autocomplete="one-time-code"` offers the SMS code in the keyboard bar as it arrives: one tap, no app switch. Email has no such affordance, so a link beats transcribing six digits. |
| **D20** | **Confirmation requires a tap, not a page load.** | Challenges are single-use, and `VerifyPage` confirms inside a `useEffect` — anything that loads the URL first spends the token. Mail security scanners prefetch links; most do not run JavaScript, which is the only reason this is not already biting. Leaning harder on links makes that margin too thin. |

---

## 3. Flow

```
   ┌─ station QR: https://skiswap.patrolkit.io/checkin?swap=<swapId>&printer=<printerId>
   │
   ├─ 1. GET /public/checkin/:swapId  ──▶ org name, logo, swap title, printer label
   │       (validates the swap is active and the printer is in the same org)
   │
   ├─ 2. person enters phone or email
   │       └─ POST /auth/login  { phone|email, context: { swapId, printerId } }
   │            └─ context validated, then stored on the challenge (D17, D18)
   │            └─ no match? sign-up form (first, last, email, phone, address)
   │                 └─ POST /public/checkin/:swapId/register  ──▶ challengeId
   │
   ├─ 3. SMS → a 6-digit code, autofilled into this tab
   │    email → a link, which opens a NEW tab (D19)
   │       └─ POST /auth/challenges/:id/confirm
   │            ──▶ { accessToken, context: { swapId, printerId } }
   │            └─ either tab can resume: the station comes back from the server, not
   │               from whichever tab happened to survive
   │            └─ contact stamped verified — the one flow where it is self-entered
   │               and therefore trustworthy
   │
   ├─ 4. POST /orgs/:orgId/ski-swap/checkin/join  { swapId }
   │       └─ upsert membership + individual SellerProfile
   │
   ├─ 5. for each item:
   │       POST /orgs/:orgId/ski-swap/seller/me/items  { ..., printerId }
   │         └─ item created, then labelsPerItem tags enqueued
   │              └─ ESP-32 claims, prints, acks  ──▶ seller peels tag, sticks it on
   │       (jam or mis-stick → POST .../items/:itemId/reprint)
   │
   └─ 6. POST /orgs/:orgId/ski-swap/checkin/finish  { swapId, printerId }
           └─ receipt enqueued, items pushed to Square
```

Steps 2 and 3 are existing endpoints with one added field each. Step 5 is the existing item
endpoint plus an optional `printerId`. The genuinely new surface is a public context
lookup, registration, join, reprint and finish.

**The seller is standing at the printer waiting**, which makes this the one place latency is
a product requirement rather than a nicety: tapping Save to paper moving should stay inside
a couple of seconds. §8 sizes the polling interval against that.

### Registration is deliberately separate from login

`/auth/login` cannot create people — it must stay non-enumerable, and creating an account
for an unknown address would make it an oracle. An unmatched seller goes through
`/public/checkin/:swapId/register`, which creates the person and issues the same kind of
challenge. The two paths converge at confirm.

Registration is rate-limited per IP and only ever creates an *unverified* person with no
memberships. Until they confirm a code they can do nothing, so an abusive caller can only
manufacture inert rows.

---

## 4. Server-side label rendering

The 867 lines in
[`PhomemoPrinterService.ts`](../../apps/web/src/lib/printing/PhomemoPrinterService.ts) lay
out labels on a `<canvas>`, `rasterise()` to `boolean[][]`, then wrap the result in ESC/POS
raster commands. This moves to the API.

### Geometry

There is one printer: the **Phomemo M110**, whose head is **400 dots** (50 mm at 8 dots/mm)
and prints the full width of 50 mm media. Paper size is a property of the media, not the
head — `40x30` is narrower stock under the same head, inset by margins.

| Media | Head | Content | Rows sent | Bytes/row | Raw |
|---|---|---|---|---|---|
| `50x30` — the size that matters | 400 dots | 400 × 224 | 240 | 50 | 12 KB |
| `40x30` — legacy | 400 dots | inset | 240 | 50 | 12 KB |

240 rows is 224 of content plus 8 blank feed rows top and bottom. 12 KB is small enough
that the queue can carry finished rasters without thinking about it.

The renderer takes geometry as **input from the printer record** rather than holding a
constant — not because heads differ today, but because two implementations have already
proved they will disagree about a hardcoded one (§1).

### Approach

Port the layout to `@napi-rs/canvas`: a prebuilt-binary Skia canvas with the same 2D API,
so drawing code transfers nearly unchanged and no build toolchain is needed on the host.
The rasteriser and ESC/POS builders are pure functions over pixel data and move verbatim.

```
apps/api/src/ski-swap/printing/
  label-renderer.service.ts   layout + rasterise  (ported)
  escpos.util.ts              command builders    (moved verbatim)
  label-templates.ts          item / receipt / QR / calibration
```

**The browser then stops rendering.** The Bluetooth path fetches the same raster from the
server and writes it over Web Bluetooth; `PhomemoPrinterService` keeps only transport —
connect, write, disconnect. That collapses today's two renderers into one *before* firmware
becomes a third, so the firmware team is not chasing a moving target.

**Golden-image tests.** Rendering has no natural assertion, so the port is verified by
committing reference rasters for fixed inputs and asserting byte equality. Fixtures cover
both media sizes and a full-width 13-character SKU (§5). They are also what the firmware
team tests against.

---

## 5. SKUs

The SKU **is** the barcode — `_drawPriceTag` renders `code128BModules(item.sku)`, so it is
the item's identity at the register rather than a label on it. It carries no PII: a prefix
derived from the swap title, a station code, and a counter.

### Station namespacing (D15)

iOS already solved this. `PatrolKitStore.nextSku` returns `PREFIX-DEVICECODE-NNNN` with the
counter held per (device, swap) in local SQLite, which is what lets offline iPads mint SKUs
without coordinating. Check-in adopts the same shape because a station *is* a device: the
printer is a registered `Device` (D8), the QR names it, and it can carry a
`skiSwapDeviceCode` like any other.

So **no extra digit is needed to mark self-check-in items** — the station code already says
where a tag came from, and reserving a code range makes it obvious at a glance.

It also removes the contention that save-time printing would otherwise create. Staff entry
was serial; simultaneous creates across stations are now normal, and a per-station counter
means they never share a row. A parallel-create test still asserts distinct SKUs, because
the failure mode is a duplicate barcode selling the wrong item.

### The barcode ceiling is 13 characters

Code128-B is `11n + 35` modules at 2 dots each, against 400 dots of head less the default
28-dot right margin:

| Format | Chars | Dots | Fits in 372 |
|---|---|---|---|
| `SS26-0042` — today, server | 9 | 268 | yes |
| `SS26-A-0042` | 11 | 312 | yes |
| `ABSS26-A-0042` — **the budget** | 13 | 356 | yes |
| `ABSS26-A-00042` | 14 | 378 | **no** |
| `ABSS26-A01-0042` — iOS format, long prefix | 15 | 400 | **no** |

Dropping `moduleW` to 1 buys room but puts the X-dimension at 0.125 mm, below what scans
reliably at 203 dpi. Code128-C would encode digits two per symbol and buy real headroom, at
the cost of a mode-switching encoder.

**A one-character station code is what makes the budget work.** With three, a six-character
prefix overflows: 6 + 1 + 3 + 1 + 4 = 15. **iOS has that bug today** — a swap titled
"Annual Backcountry Ski Swap 2026" derives `ABSS26` and prints a barcode wider than the
label, invisible only because prefixes have happened to be short. One character brings it
to 13 exactly, so `deriveSkuPrefix` keeps its six-character cap and no live swap needs
rewriting.

### Making one character enough

The code pool is per-org, and today it is smaller and more crowded than it looks:

- **`generateSkiSwapCode` is base-26, letters only** — `A`…`Z`, then `AA`. Widening to
  letters plus digits reaches 36; excluding the glyphs that read ambiguously — `I`, `O`,
  `0`, `1` — leaves **32**, which is the better trade, since the code prints as text under
  the barcode and gets read aloud across a counter.
- **Every device consumes a code**, whatever its role: `create` calls
  `assignSkiSwapDeviceCode` unconditionally, so time-clock and signage devices eat ski-swap
  namespace. Scoping assignment to ski-swap roles reclaims most of the pool.

**Exhaustion must be a hard error.** The generator spills to two characters at 27, which
under a fixed-width budget silently produces a 14-character SKU and a barcode wider than
the label. Running out has to fail loudly at device provisioning — where a human can free a
code — rather than at print time, where it yields an unscannable tag nobody notices until
the register.

### Ordering

Within the save request: the item is created and committed, *then* the label renders,
*then* the job is enqueued. That is where the request ends. Rendering must not happen
inside the create transaction — a canvas render is slow enough that holding write locks
across it would serialise check-in unnecessarily.

`hasPrintedTag` is set later, by the **ack** (D13), once every job for that item has
printed. With `labelsPerItem` above one an item has several jobs, so the flag flips when
none remain unprinted, not on the first ack.

That gives one honest failure state for four different failures. A render that throws, an
enqueue that fails, a printer that jams, a roll that runs out — each leaves a saved item
whose flag is still false. The UI shows it unprinted and the seller taps reprint; they
never need to know which of those happened, because the remedy is the same.

Retry safety comes from the idempotency key on create, not from the flag: a create whose
response was lost is replayed under the same key and returns the original item rather than
making a second one.

---

## 6. Sign-in context

`ContactChallenge` gains one nullable column:

```prisma
  /// What this sign-in was for, so the session can resume it whichever browser
  /// context confirms. Structured and server-interpreted — never a URL (D18).
  /// { swapId, printerId } today; other flows may add their own shapes.
  context Json?
```

Three rules keep it safe:

- **Validated at issue, not at use.** `swapId` must name an active swap and `printerId` a
  printer in that swap's org. A challenge storing an invalid pairing would fail later, in
  the new tab, where there is no good way to recover.
- **Returned, never redirected to.** Confirm hands back `{ swapId, printerId }` and the
  client decides what to render. The server never issues a redirect from stored context,
  which is what keeps this from becoming an open redirect.
- **Scoped to the challenge.** It lives and dies with the row, gone once the challenge is
  used or expires. Nothing about a station persists on the person (D5).

This is deliberately generic. Check-in is the immediate need, but any flow that has to
survive a sign-in — deep-linking to an item, claiming a seller page from a printed QR —
uses the same column rather than inventing its own workaround.

---

## 7. Hosting on the seller site

Caddy already serves `patrolkit.io`, `www.patrolkit.io` and `skiswap.patrolkit.io` from the
same backend, and the SPA branches on hostname: `isSellerSite` is
`hostname.startsWith('skiswap.')`. Check-in slots into that branch (D2). Three
consequences, one of which is a genuine break.

**The seller site has no authentication today.** Its routes render *outside* `AuthProvider`
— every page there is public. Check-in is the first authenticated surface on that host, so
the provider has to wrap the branch. Public pages keep working; they simply never consult
it.

**Sessions already span the subdomain.** The refresh cookie is issued with
`domain=patrolkit.io`, which covers `skiswap.patrolkit.io`, and Caddy proxies both hosts to
the same API, so calls stay same-origin. Nothing to change — worth stating because it is
the sort of thing that looks broken the first time someone tests from the wrong host.

**Emailed sign-in links currently point at the wrong site.** `ContactChallengeService`
builds every link from a single `APP_URL`, which in production is `https://patrolkit.io`. A
seller signing in by email would be sent to the *admin* domain and land in the staff SPA
branch, never reaching check-in — even with the context preserved perfectly. The context
survives; the hostname does not.

The fix keeps D18 intact: the server picks the origin from the *kind* of context on the
challenge rather than accepting one from the client. A challenge carrying check-in context
builds against a new `SELLER_SITE_URL`; everything else keeps `APP_URL`. The destination
stays server-determined, with no client-supplied URL anywhere near it.

---

## 8. The print queue

### Schema

```prisma
model PrintJob {
  id        String @id @default(cuid())
  orgId     String
  printerId String
  /// Set when a job belongs to a check-in; null for staff-initiated reprints.
  swapId    String?
  sellerId  String?
  /// The item this tag depicts. Null for receipts and calibration. What lets an
  /// ack flip `SwapItem.hasPrintedTag` once every tag for that item has printed.
  itemId    String?

  /// item | receipt | qr | calibration — what the payload depicts.
  kind    String
  /// 1-bit raster, run-length encoded. Rendered at enqueue time, so a later
  /// template change never rewrites a job already queued.
  payload Bytes
  /// Ordering within one seller's batch, so tags emerge in entry order.
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

  org     Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  printer SwapPrinter  @relation(fields: [printerId], references: [id], onDelete: Cascade)

  @@index([printerId, status, seq])
  @@index([itemId, status])
  @@index([status, claimUntil])
  @@index([orgId, createdAt])
}
```

`SwapPrinter` gains a device link (D9):

```prisma
  /// Set when this printer is an ESP-32 pulling from the queue rather than a
  /// Bluetooth device driven by a browser.
  deviceId   String?   @unique
  lastSeenAt DateTime?

  device Device? @relation(fields: [deviceId], references: [id], onDelete: SetNull)
```

`SkiSwap` swaps its single counter for per-station counters, and gains an active-only
prefix mirror (D15, D16):

```prisma
model SkiSwap {
  skuPrefix       String
  /// Mirror of skuPrefix, written only while the swap is active. MySQL allows
  /// many NULLs in a unique index, so inactive swaps never collide (D16).
  activeSkuPrefix String?

  skuCounters SwapSkuCounter[]

  @@unique([orgId, activeSkuPrefix])
}

/// One counter per station per swap, so stations never contend (D15).
model SwapSkuCounter {
  id          String @id @default(cuid())
  swapId      String
  /// Device.skiSwapDeviceCode — one character, unique per org.
  deviceCode  String @db.VarChar(1)
  lastCounter Int    @default(0)

  swap SkiSwap @relation(fields: [swapId], references: [id], onDelete: Cascade)

  @@unique([swapId, deviceCode])
}
```

Activating a swap writes `activeSkuPrefix`; deactivating clears it. A collision surfaces at
activation with a clear error rather than silently issuing duplicate SKUs, and
`deriveSkuPrefix` disambiguates at creation by appending a digit when the derived prefix is
already live.

### Firmware contract

Three endpoints, all device-authenticated, all scoped to the calling device's own printer.

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/devices/me/print-jobs/claim` | Atomically claims up to `n` queued jobs, oldest `seq` first. Sets `status=claimed`, `claimUntil=now+90s`, increments `attempts`. Returns `{id, kind, seq, payload}` and a `backoffMs`. Empty array when idle. |
| `POST` | `/devices/me/print-jobs/:id/ack` | `status=printed`, and sets `SwapItem.hasPrintedTag` once no unprinted jobs remain for that item (D13). Idempotent — acking a printed job is a no-op, so a retried ack after a dropped response is safe. |
| `POST` | `/devices/me/print-jobs/:id/nack` | Returns the job to `queued` and clears the claim. Body carries `{error}`. After 5 attempts it goes to `abandoned` rather than looping. |

**Transport is short polling, at 1 second while a station is active.** An ESP-32 holding a
TLS socket open is the least reliable part of the system, and a poll recovers from a
dropped connection by polling again. The interval is a product constraint, not a free
choice: the seller is waiting for a tag they are about to stick on a ski, so worst-case
pickup latency *is* the poll interval. One request per second per station is negligible at
a dozen stations, and `backoffMs` lets the server slow idle stations without a firmware
change. Long-polling can replace this later behind the same contract.

**The claim is a single atomic UPDATE**, not read-then-write:

```sql
UPDATE PrintJob SET status='claimed', claimedAt=NOW(3), claimUntil=NOW(3)+INTERVAL 90 SECOND,
       attempts=attempts+1, claimToken=?
 WHERE printerId=? AND (status='queued' OR (status='claimed' AND claimUntil < NOW(3)))
 ORDER BY seq, createdAt LIMIT ?
```

then select the rows bearing that token. Two printers racing, or one whose earlier claim
expired mid-print, cannot both win the same row. Reaping rides on the same query — an idle
system does no work and a busy one self-heals — rather than running as a scheduled sweep.

### Enqueue, reprint, finish

**Enqueue hangs off item creation** (D11). `POST /orgs/:orgId/ski-swap/seller/me/items`
gains one optional `printerId`; when present the service renders and enqueues
`labelsPerItem` tags for the item it just created. Absent — the desktop portal, a business
seller working from home — nothing prints and the endpoint behaves as it does today. One
code path, one branch.

An item is never enqueued twice: the service refuses when live jobs already exist for it
(D12). The guard is the queue, not `hasPrintedTag` — that flag is still false in the
seconds between enqueue and ack, which is exactly when a seller is most likely to spot a
typo and edit.

**Reprints are explicit.** `POST .../items/:itemId/reprint { printerId }` re-enqueues one
item — the answer to a jam, a mis-stick, or an unreadable tag. It renders from the item's
**stored** SKU and never increments a counter, so a reprint is byte-identical to the
original. It is the only path that deliberately prints an item twice.

**Finish** enqueues the receipt and pushes items to Square (D14).

**The receipt already exists and paginates itself.** `generateReceiptHeaderLabel` renders
one label with the org logo, date, seller name, phone and a QR to their item-status page;
`generateReceiptItemLabels` takes `{name, sku, priceCents}[]` and returns as many labels as
the list needs. So the receipt is a header job followed by *n* item jobs sharing a `seq`.
No new label design — this is the existing code ported alongside the tag templates (§4).

### What stops someone printing from off-site

The station QR is printed and static, so it will be photographed. Three things bound what
that is worth:

1. **The swap must be active.** Enqueue is refused otherwise, so an out-of-season QR is
   inert.
2. **They must sign in**, proving an email or phone. There is no anonymous path, and every
   job is attributable to a verified contact.
3. **Queue depth is capped per printer**, and staff can see and clear it (§9).

The residual risk is that an identified person wastes some paper, visibly, while a swap is
running — and deliberately *not* solved by locking the station to one seller, because a
lock is seizable remotely and turns paper waste into denial of service (D5).

Genuinely closing it means proving physical presence: a short-lived code shown at the
station and typed in by the seller. That needs a screen or a staff tap per seller, against
a threat whose worst outcome is a wasted roll of labels. Worth revisiting only if it stops
being theoretical.

---

## 9. API surface

### New — public

- `GET /public/checkin/:swapId` — org name, logo, swap title, printer label. Validates the
  swap is active and the printer belongs to the same org. Throttled.
- `POST /public/checkin/:swapId/register` — creates an unverified person and issues a
  challenge. Throttled hard.

### New — seller

- `POST /orgs/:orgId/ski-swap/checkin/join` — upserts membership and an individual
  `SellerProfile`.
- `POST /orgs/:orgId/ski-swap/seller/me/items/:itemId/reprint` — re-enqueues one item's
  tags.
- `POST /orgs/:orgId/ski-swap/checkin/finish` — receipt, then the batched Square push.

### New — device

- `POST /devices/me/print-jobs/claim`
- `POST /devices/me/print-jobs/:id/ack`
- `POST /devices/me/print-jobs/:id/nack`

### New — staff

- `GET /orgs/:orgId/ski-swap/printers/:printerId/queue` — depth, last-seen, failures. Staff
  need to see a stuck station without reading logs.
- `POST /orgs/:orgId/ski-swap/printers/:printerId/test` — enqueues a calibration label.

### Changed

- `POST /auth/login` gains an optional structured `context` (§6), validated at issue.
- `POST /auth/challenges/:id/confirm` returns that `context` alongside the session.
- `POST /orgs/:orgId/ski-swap/seller/me/items` gains an optional `printerId` and accepts an
  idempotency key, so an ambiguous failure can be retried safely.
- **`ItemService.create` stops awaiting Square** for check-in items — `syncItemToPos` and
  `fetchInventoryMap` both leave the save path (D14). Staff-created items are unchanged.
- `SwapPrinter` responses gain `deviceId`, `lastSeenAt`, `queueDepth`.
- `DEVICE_ROLES` gains `Ski Swap - Printer`.
- Browser printing fetches rasters from the server instead of rendering locally.

### Configuration

- `SELLER_SITE_URL` — the origin sign-in links use when a challenge carries check-in
  context (§7). `https://skiswap.patrolkit.io` in production; the same origin as `APP_URL`
  locally, where there is no subdomain.

---

## 10. Web work

### Check-in is its own surface

`BusinessSellerPage` is **not** the check-in UI. It is a desktop portal for a business
seller managing a catalogue from an office; retrofitting it into a one-handed venue flow
would serve neither well. Check-in gets purpose-built screens that share the API and
nothing else.

- **`/checkin` lives in the seller-site branch of `App.tsx`** (D2), which today returns a
  bare `<Routes>` with no `AuthProvider`. That branch gains the provider, and `/checkin`
  must be declared ahead of the existing `:orgSlug` catch-all — React Router ranks static
  segments above dynamic ones, so this works, but it is load-bearing and worth a comment.
- **`/checkin`** reads `swap` and `printer` from the query string and holds them for the
  session, and can also recover them from a confirm response when an emailed link lands the
  seller in a fresh tab (D17). Walks: context → sign in or register → code → join → items →
  finish.
- **Item entry is the screen that matters.** One item at a time, one column,
  thumb-reachable primary action. Printing must be visible: which item is printing, whether
  the tag came out, and a one-tap reprint when it did not.
- **`VerifyPage` gains a confirm button** rather than firing on mount (D20), and routes
  into check-in when the returned context carries a station.
- **Fix the seller redirect** — derive from `membership.roles.includes('seller')` rather
  than the retired `business_seller` permission (§1).
- **Station queue view** for staff, off the printers tab: depth, last-seen, failures, retry.

### What phone-first means here

Not a breakpoint. These are the constraints that change the design:

- **Cold start in Safari.** The iOS camera app opens QR links in a fresh tab, so `/checkin`
  must work unauthenticated, with no prior state, from a link alone.
- **The keyboard eats the viewport.** Item entry has to stay usable in roughly 300px of
  visible height, ruling out tall forms and fixed footers that end up behind the keyboard.
- **Inputs must not zoom.** iOS Safari zooms any focused input below 16px, and once zoomed
  the layout stays wrong for the rest of the session.
- **The right keyboard per field.** `inputMode="decimal"` for price, `type="tel"` for
  phone, `autocomplete` on sign-up fields.
- **`autocomplete="one-time-code"` on the SMS code input.** This is what makes the texted
  code one tap rather than six keystrokes, and the entire reason D19 keeps SMS on codes.
- **Photos come from the camera** via `capture="environment"`, downscaled in the browser
  before upload. A modern phone photo is several megabytes and venue wifi is not.
- **`100vh` is a lie on iOS.** Use `100dvh` and respect `env(safe-area-inset-*)`, or the
  primary action sits under the home indicator.
- **The session must survive backgrounding.** Taking a photo suspends the tab; returning
  must not mean signing in again.

### Network

Venue connectivity is a **venue-readiness commitment**, not something the software absorbs.
An offline outbox would hold saves and replay them on reconnect — but since tags are
enqueued server-side, nothing could print until the network returned, so a run of tags
would emerge at once and the seller would be back to matching labels against a pile. That
is precisely the batch model D11 rejected; machinery whose best case is the outcome we
designed against is not worth building.

Two cheap things stay, covering the brief blips that happen even on good wifi:

- **The in-progress item persists to `localStorage`** on change, so a reload or a
  backgrounded tab never loses typing.
- **Saves carry an idempotency key**, so a retry after an ambiguous failure cannot create
  the item twice. `IdempotencyService` already exists server-side.

Every item shows **saved → printing → printed**, driven by `hasPrintedTag` rather than by
optimism, plus a failed state when its jobs are abandoned. A seller watching for paper
should see the same thing the printer reported, and must never be unsure whether something
is recorded.

### Local development

`isSellerSite` keys off `hostname.startsWith('skiswap.')`, so on `localhost:3000` the
seller branch never activates and check-in is unreachable. Browsers resolve any
`*.localhost` name to loopback, so `http://skiswap.localhost:3000` exercises the real
branch without touching `/etc/hosts` — Vite needs `server.host` set to accept it.

### Verification

Responsive CSS is not evidence. The web phase is verified on a real phone-sized viewport
with touch emulation, walking the whole flow, plus a pass on physical iOS hardware before a
swap — `100dvh`, input zoom and camera capture are all behaviours the desktop browser will
happily lie about.

---

## 11. Work breakdown

**Phase 1 — Server-side rendering.** Port layout to `@napi-rs/canvas`; move the rasteriser
and ESC/POS builders; golden-image fixtures including a full-width 13-character SKU. Carry
the web's geometry — 400-dot head, 50 bytes per row — as an input from the printer record
rather than a constant. Nothing calls it yet.

**Phase 2 — Browser renders via the server.** Point the Bluetooth path at the new endpoint
and strip layout from `PhomemoPrinterService`, leaving transport. Two renderers become one,
before firmware exists.

**Phase 3 — Queue.** `PrintJob`, `SwapPrinter.deviceId`, the atomic claim, the three device
endpoints, the `Ski Swap - Printer` role. Testable end to end with a fake device — no
hardware needed.

**Phase 4 — Sign-in context and link origin.** `ContactChallenge.context` plumbed through
login and confirm with issue-time validation; `SELLER_SITE_URL` and origin selection driven
by the context's shape; `VerifyPage` converted to tap-to-confirm. Small, and independently
useful — it is what lets any flow survive a sign-in.

**Phase 5 — SKUs.** Narrow `skiSwapDeviceCode` to one character over a 32-glyph alphabet,
scope its assignment to ski-swap roles, make exhaustion a hard error, move generation to
per-station counters, and add the active-prefix constraint. A parallel-create test asserts
distinct SKUs.

**Phase 6 — Check-in.** `PublicCheckinService`, register, join. Wire save-time enqueue into
item creation in commit → render → enqueue order, with `hasPrintedTag` set by the ack;
add reprint. Move the Square push
into `finish` and call the existing receipt templates from it. Fix the seller redirect.

**Phase 7 — Web.** `AuthProvider` over the seller-site branch, purpose-built `/checkin`
screens leading with phone sign-in, local draft persistence, station queue view, and a
`skiswap.localhost` dev path. Verified against the seller host — the admin host exercises
the wrong branch entirely.

**Phase 8 — Hardening.** Reaping under load, queue-depth alerting, abandoned-job
visibility, and a documented recovery path for "the printer died mid-swap".

---

## 12. Accepted costs

- **A rendering dependency in the API.** `@napi-rs/canvas` ships prebuilt binaries, so no
  build toolchain, but it is a native module and pins us to supported platforms.
- **40 mm media is under-served.** Both sizes render at the full 400-dot head width, so
  40×30 depends on margins to stay on the label. `50x30` is the size that matters and is
  correct; if 40×30 returns it wants its own inset, not a new head geometry.
- **Duplicate tags are possible by construction (D10).** A printer that prints and fails to
  ack will reprint on retry. Cheap, and the alternative loses tags.
- **The seller is blocked on the printer.** Save-time printing ties the pace of check-in to
  hardware: a jam or an empty roll stops that station, where batch printing would have let
  entry continue. The right trade for tag-to-item accuracy, but it makes printer health a
  live operational concern — which is why §9 exposes queue depth and last-seen.
- **Check-in requires the network, by choice (§10).** A station with no connectivity cannot
  check anyone in. Venue wifi is a hard dependency, worth verifying before doors open
  rather than with a queue of people waiting.
- **Two sellers at one station produce interleaved tags.** Nothing prevents it, by
  design (D5): the floor plan is what keeps stations to one seller at a time, and when it
  slips the item description on the tag is what tells people whose is whose. Cheap to
  recover from, and cheaper than state that would be stale as often as it was right.
- **No approval gate (D6)** means a mistyped price goes live immediately. Staff can edit
  after the fact, and the tag is the artefact that matters physically.
- **13 characters is a hard ceiling** until the encoder changes (§5). D15 spends it exactly
  — 6 prefix, 1 station, 4 counter, 2 separators — with nothing spare. Another field later
  means Code128-C, not another separator.
- **32 station codes per org.** Ample once the pool is scoped to ski-swap devices, but a
  ceiling where there was none: the generator used to spill to two characters rather than
  run out.
- **SKU numbers are not contiguous.** A create that fails after the counter increments
  burns that number. Harmless for uniqueness, but reconciling a swap by counting SKUs
  rather than items will be wrong.
- **Square goes stale during check-in.** Deferring the push to finish (D14) means items are
  invisible in Square until a seller finishes, so a swap in progress under-reports. Nothing
  consumes that mid-swap today, but it is a behaviour change.
- **The seller site gains an authenticated surface.** It has been entirely public, which
  made it easy to reason about. Its routes now divide into public and not, and that
  division has to be maintained rather than assumed.
- **`ContactChallenge` gains a `Json` context column** — a generic escape hatch on a
  security-sensitive record. D18's rules are what keep it from drifting into a `returnTo`
  field, and they need holding on review.
- **An emailed link still means leaving the browser.** The seller taps a notification, Mail
  opens, they tap once more and land back in Safari. Fewer steps than transcribing six
  digits, more than the SMS path, and dependent on their mail app behaving. The UI nudges
  toward phone.

---

## 13. Open question: retiring the unauthenticated lookup

Everything else has been answered and folded into the decisions above. This one remains:
**should the public `/s/:sellerId` page survive** once sellers can sign in?

Worth doing, but not yet, and not entirely.

**The weakest part is already gone.** `seller-find`, which matched an email against the
last four digits of a phone number, was removed in Plan 10. That was the one that let a
stranger guess their way to a record.

**What is left is different in kind.** `/s/:sellerId` is a capability URL — an unguessable
cuid handed to a specific person and printed on their receipt QR. It leaks nothing to
someone who does not have it. Requiring sign-in would still be better, since a link once
shared cannot be un-shared, but the gap is narrower than it looks.

**Two things block retiring it.** The first is the receipt QR itself: if that page requires
auth, the QR becomes a sign-in prompt — though in practice it was scanned with the phone
they checked in on, whose session is still valid, so it would usually just work.

The second is the real blocker: **staff-created sellers cannot sign in.** The Sellers tab
still creates people from a name and a typed phone number, with no verified contact. An
authenticated status page would lock out precisely the people that path exists for.

**So the sequence is:** keep `/s/:sellerId` while self-check-in proves itself; point the
receipt QR at an authenticated page that falls back to sign-in; revisit once the share of
sellers with a verified contact is high enough that the capability URL serves an edge case
rather than a population. That is a data question, and check-in is what produces the data.
