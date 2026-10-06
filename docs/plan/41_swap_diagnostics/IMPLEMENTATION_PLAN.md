# Plan 41: Swap diagnostics: does Square agree with us?

## Goal

A check staff run every night of a swap, from the swap list: **Swaps → a swap's Diagnostics action → a popover → Run checks.** It compares the swap's items in PatrolKit with the swap's items in Square, matched by SKU, and lists every disagreement as an issue. Staff choose what to do about each one. Nothing changes until someone clicks a choice.

| Issue | Choices |
|---|---|
| **Only in Square:** a SKU we don't have | Copy to PatrolKit · Mark resolved |
| **Only in PatrolKit:** a SKU Square doesn't have | Copy to Square · Mark resolved |
| **Differs:** the name, notes or price disagree | Use Square's · Use ours · Mark resolved |
| **Not linked:** our record doesn't point at the matching Square item | Link to it · Mark resolved |
| **Twice in Square:** the same SKU more than once | Keep this copy (one per copy) · Mark resolved |

## What's already here

- **Pushing to Square.** `IPosAdapter` (`pos/pos.adapter.ts`) creates and updates items one at a time (`syncItem`) or in bulk (`syncNewItems`). Each item is one Square ITEM in the swap's category (`SkiSwap.squareCategoryId`) with one variation. The ITEM carries our name and notes (`description`); the variation carries the SKU and price. An unpriced ticket is variable-priced. Each swap has its own category and its own location, so the category is what makes an item part of a swap.
- **What we store.** `SwapItem.squareItemId`, `squareVariationId` and `lastSyncedAt`. There's no sync status or last error: a failed push is logged and forgotten. An item belongs in Square exactly when it's live (`deletedAt` null) and consigned (`consignedAt` set).
- **How an item misses Square.**
  - A failed push isn't retried. Only a later edit or consign of the item fixes it, or, for tickets, "Put tickets in Square".
  - Self check-in on a seller's phone saves each item to PatrolKit as it's entered, and queues its tag. To keep each save quick, it sends the items to Square together when the seller taps Finish. A seller who walks away before Finish leaves items that are in PatrolKit, possibly tagged, and not in Square. The iPad and the Items page send each item as it's saved.
- **Reading Square.** The adapter can't list or search catalog items, and nothing handles Square's rate limit (HTTP 429).
- **Two meanings of "not in Square".** The Items page filter `not_in_square` keys on `squareVariationId`; the row badge and the ticket push key on `squareItemId`.
- **The Swaps page** (`SwapsPage.tsx`) has plain row buttons (Edit, Activate/Deactivate) for `ski_swap:admin`. `TicketSquareModal.tsx`, a polling query and one action, is the popover to imitate.

## Decisions

| # | Decision |
|---|---|
| D1 | **Matched by SKU, within the swap's Square category.** Ours: the swap's live items. Square's: every item in the swap's category, keyed by its variation's SKU. Category and location aren't compared, because the category defines the swap and each swap has its own location. SKUs aren't compared either; they're the key. |
| D2 | **The issues.**<br>• **Only in Square:** a SKU in the category that no live item of ours has. If one of our deleted items has that SKU, the row says so.<br>• **Only in PatrolKit:** a live, consigned item whose SKU isn't in the category. The popover names the likely causes: a push that failed, or a self check-in the seller never finished. An unconsigned item isn't expected in Square and isn't an issue.<br>• **Differs:** one issue per field (name, notes, price) that disagrees, showing ours and Square's. Notes compare trimmed, with blank and missing alike. A variable price in Square reads as "no price".<br>• **Not linked:** the SKU matches one Square item, but the Square ids we stored are missing or point at a different item. It happens when a push reached Square and saving the ids failed. Left alone, the Items page calls the item "not in Square", and its next edit pushes a second copy.<br>• **Twice in Square:** the same SKU on more than one Square item in the category. Listed once, with each copy's Square id, name, price and when Square last changed it (Square keeps no creation time). |
| D3 | **What each choice does.**<br>• **Copy to PatrolKit:** asks for the seller (a searchable list), and creates the item with Square's SKU, name, notes and price, consigned and linked to the Square item. Nothing is pushed. If one of our deleted items has the SKU, it offers to restore that item instead, with its seller and details, linked to the Square item.<br>• **Copy to Square:** sends our item as any push does, and stores the new Square ids.<br>• **Use Square's:** writes Square's value straight to our item. Not through the item edit, which pushes to Square by the stored ids and, on an item not linked, would make a second copy; the write still moves `updatedAt`, so the iPads get the change. Only a ticket may take "no price", since tickets are the only items allowed to be unpriced; for anything else the choice isn't offered.<br>• **Use ours:** sends our item's details to that Square item.<br>• **Link to it:** stores that Square item's ids on our item. Nothing is sent to Square.<br>• **Keep this copy:** links our item to that copy and deletes the other copies from Square. The kept copy is then compared with ours like any other, so its differences show as new rows.<br>• **Mark resolved:** changes nothing (D5). |
| D4 | **Every issue needs a click, one row or one group at a time.** Each row has its own choices. Each group also offers them for all its open rows ("Copy all 300 to Square"), with a confirm naming the count. Copy to PatrolKit for a group asks for one seller for them all, and restores deleted items where it can. Link to it for a group links each item to its own match. Keep this copy has no group form, because each needs its own pick. |
| D5 | **Mark resolved works for an issue left as it is, and for one fixed by hand in Square or PatrolKit.** It changes nothing itself. When clicked, it re-reads both sides for that SKU:<br>• **They now agree:** recorded as "Resolved, fixed". Nothing is hidden, so if the problem comes back, the next run raises it.<br>• **They still disagree:** recorded as "Resolved, left as is", and the values as they are at the click are hidden. Later runs don't raise the issue while both sides hold those values. If either side changes (the price moves again, the item reappears, a Not linked item's stored ids or its Square match change), it comes up as a new issue. |
| D6 | **Nothing is applied to stale data.** Before any choice except Mark resolved, the server re-reads that SKU on both sides. If either has changed since the run, it refuses: "This changed since the check ran. Run the checks again." Mark resolved is exempt, because a change since the run is what a fix by hand looks like (D5). |
| D7 | **Square is read and written in bulk.** A run makes one read: `catalog.searchItems` filtered to the swap's category, 100 items per page, about 100 calls for 10,000 items. Re-reading chosen SKUs (D5, D6) is `catalog.search` on the variations' SKUs, with related objects. Writes fetch current versions with `catalog.batchGet` (1,000 per call), upsert with `catalog.batchUpsert` (500 per call), and remove extra copies with `catalog.batchDelete`. A group choice for 1,000 rows is a handful of calls and a few seconds. |
| D8 | **Rate limits.** Every new Square call retries on a 429, honoring `Retry-After`, otherwise backing off 1, 2, 4 and 8 s, five tries at most. Calls run one at a time, so a run never competes with the register for Square's limit. |
| D9 | **A run is a background job on the server.**<br>• `POST …/swaps/:swapId/diagnostics` starts a run and returns its id. One run per swap at a time; a second POST returns the run already going.<br>• The run records its progress ("Reading Square: 3,200 items") and, when done, its issues.<br>• `GET …/diagnostics/latest` returns the latest run, running or finished, with its issues and their state. The popover opens on it, so last night's answer and what was done about it are there before anyone presses anything.<br>• A run still marked running ten minutes after its last update shows as interrupted (a deploy restarted the server), to be run again. |
| D10 | **Three new tables.**<br>• `SwapDiagnosticRun`: `id`, `orgId`, `swapId`, `startedBy`, `startedAt`, `updatedAt`, `finishedAt`, `status` (running, done or failed), `done`, `error`, and the counts per issue.<br>• `SwapDiagnosticIssue`: `id`, `runId`, `swapId`, `sku`, `kind`, `field` (for Differs), `ours` and `square` (JSON: the values compared, with ids), `fingerprint` (both sides' values, hashed), `state` (open, applied, fixed, left or failed), `choice`, `decidedBy`, `decidedAt`, `error`.<br>• `SwapDiagnosticHidden`: `swapId`, `sku`, `kind`, `field`, `fingerprint`, `hiddenBy`, `hiddenAt`, unique on the first five. Hiding (D5) is a lookup in it: a new issue matching a row isn't recorded. Left as is stores the fingerprint of the values at the click, not at the run. Apart from the issues because those are pruned with their runs, and a hide lasts as long as its swap.<br>• The last 30 runs per swap are kept, with their issues. |
| D11 | **Every choice is audited** (`ski_swap.diagnostics.applied`), with the SKU, the issue, the choice and both values. Prices are money, and "who changed this and why" gets asked after the swap. |
| D12 | **Who:** `ski_swap:admin` runs checks, sees results and chooses, the same group that sees the Swaps page's actions. |
| D13 | **Out of scope:** stock (we don't track it, and nothing here reads it), running on a schedule, emailing results, comparing nights, and other checks (unpriced items, tags, sellers we can't pay). |
| D14 | **"Not in Square" means one thing everywhere: missing either id.** The Items page filter and the row badge change to match. |

## Server

### The adapter (`pos/pos.adapter.ts`, `pos/square.pos.adapter.ts`, the stub)

- **`listCategoryItems(categoryId)`** returns every item in the category as `{ itemId, variationId, sku, name, description, pricing: { type: 'fixed', cents } | { type: 'variable' }, version, createdAt }`.
- **`itemsBySku(categoryId, skus)`** returns the same shape for the category's items with those SKUs: the re-read for D5 and D6.
- **`upsertItems(items, locationId)`** writes many items at once: existing ones with their id and a fresh version, new ones without. Each is built by the same `itemObject` as `syncItem`, so it ends up exactly as a single push leaves it, and new items get their starting stock as `syncNewItems` gives them. A batch refused for a version mismatch is retried once with fresh versions; a batch that still fails is reported with Square's message, and the others stand. Returns `{ posItemId, posVariationId }` per item.
- **`deleteItems(ids)`**, which exists already, removes extra copies.
- **`withRateLimitRetry(fn)`** wraps every new call (D8).
- The stub adapter (`payouts/stub.providers.ts`) implements them all from its in-memory catalog, so tests and local runs need no Square.

### The checks (`ski-swap/diagnostics/`)

- **`diagnose.ts`** is a pure function, kept apart so it can be tested. It takes our live items (id, sku, name, description, priceCents, consignedAt and the stored Square ids), our deleted items' SKUs, and Square's items, and returns the issues (D2) with their fingerprints. Prices compare in cents, names exactly, and notes as in D2. Runs use it on the whole category; Mark resolved and the staleness check use it on one SKU.
- **`swap-diagnostics.service.ts`:**
  - `start(orgId, swapId, userId)` creates a run, or returns the one already running, and runs it without waiting. A run lists the category, records progress per page, diagnoses, drops issues whose fingerprint was left as is (D5), saves the rest, and prunes to 30 runs. On an error it records `failed` with Square's message.
  - `latest(orgId, swapId)` returns the latest run with its issues.
  - `apply(orgId, swapId, issueId, choice, extra)` applies one choice (D3) after the staleness check (D6). Mark resolved re-reads both sides instead and records fixed or left (D5). `extra` carries the seller, the deleted item to restore, or the copy to keep.
  - `applyAll(orgId, runId, kind, field, choice, extra)` applies a choice to every open issue in a group (D4). Square writes go through `upsertItems` in bulk, our writes item by item. Stale issues are skipped and reported, except under Mark resolved. Returns applied, skipped and failed counts.
  - Copy to PatrolKit reuses `ItemService.create`, with the Square ids supplied and the push skipped; restoring a deleted item sets `deletedAt` null, `liveSku` back, and links it. Use Square's and Link to it write the item directly (D3).
- **`swap-diagnostics.controller.ts`**, all `ski_swap:admin`:
  - `POST orgs/:orgId/ski-swap/swaps/:swapId/diagnostics` starts a run → `{ runId }`.
  - `GET …/diagnostics/latest` → the run with its issues (D9), or null.
  - `POST …/diagnostics/issues/:issueId` with `{ choice, sellerId?, restoreItemId?, keepSquareItemId? }` → the issue's new state.
  - `POST …/diagnostics/runs/:runId/apply-all` with `{ kind, field?, choice, sellerId? }` → `{ applied, skipped, failed }`.
- **Contracts** in `ski-swap.contracts.ts`: the run, the issue, and both request bodies.
- **D14:** `item.service`'s `not_in_square` becomes `OR: [{ squareItemId: null }, { squareVariationId: null }]`, and `squareSynced` requires both ids.

### Migration

`SwapDiagnosticRun`, `SwapDiagnosticIssue` and `SwapDiagnosticHidden` (D10). Issues are indexed on `(runId, kind)`; hides are unique on `(swapId, sku, kind, field, fingerprint)`. All three are deleted with their swap. Additive; nothing else changes.

## Web

- **`SwapsPage.tsx`:** a **Diagnostics** button in each row's actions, beside Edit, for `ski_swap:admin`. It opens `SwapDiagnosticsModal`.
- **`SwapDiagnosticsModal.tsx`:** `TicketSquareModal`'s overlay, × button and Escape, wider (`max-w-4xl`).
  - **Header:** the swap's title and "Last run 9:42 PM by Dana · took 48 s · 9,812 in PatrolKit · 9,809 in Square"; "Not run yet" before the first run; "Interrupted, run again" for a stale run (D9).
  - **Run checks.** While a run is going, its progress, polling `latest` every 2 s.
  - **"Everything matches"**, with a green check, when nothing is open.
  - **One group per issue kind** (and per field for Differs), each with its count of open rows, one line on what it means for the register, and its group choices (D4).
  - **Each row:** the SKU (linking to the Items page's edit), name, seller, ours and Square's side by side, and its choices as buttons. Copy to PatrolKit opens the seller picker, or the restore offer. A decided row greys out and shows what was chosen ("Resolved, fixed" or "Resolved, left as is" for Mark resolved), by whom and when. A failed row shows Square's message and keeps its buttons.
  - Long groups show 100 rows at a time, then "Show 100 more".
- **API client:** `startDiagnostics`, `latestDiagnostics`, `applyDiagnosticChoice` and `applyDiagnosticChoiceToAll`, with types in `api.types.ts`.

## Rollout

- **Migration:** three new tables, additive. Ask before applying them.
- **Deploy outside swap hours,** and not while a run is going: a deploy interrupts it (D9).
- **First run** in the test org, then once on the live swap while the register is closed. Choose nothing on that first live run; read what it finds first.
- **Nothing for the iPad.** Changes from Use Square's and Copy to PatrolKit reach it through the normal item sync.

## Tests

**Server:**
- `diagnose.spec.ts`:
  - each issue kind in D2, and each Differs field;
  - an item matching in every field (no issue);
  - an unpriced ticket variable-priced in Square (no issue);
  - an unconsigned item missing from Square (no issue);
  - a SKU only in Square that matches one of our deleted items (flagged);
  - a SKU twice in Square;
  - a matching item with no stored ids, and one whose stored ids point at another Square item (Not linked);
  - blank notes on one side and none on the other (no issue);
  - the same values giving the same fingerprint, and any change giving a new one.
- Service:
  - one run per swap; progress and failure recorded; pruning to 30 runs; a stale running run reads as interrupted;
  - Mark resolved on an issue fixed by hand since the run: accepted despite the change, recorded as fixed, nothing hidden, raised again if the same problem returns;
  - Mark resolved on an issue left as is, for each kind, Not linked included: recorded as left, not raised again with the same values, raised once a value changes;
  - Mark resolved after a change that still disagrees: the new values are what's hidden;
  - each choice in D3 does what it says, including restoring a deleted item, Link to it sending nothing to Square, and Keep this copy deleting the others;
  - Use Square's "no price" refused for a non-ticket;
  - any other choice on stale data refused (D6);
  - a group choice applies to open rows only, skips stale ones (except Mark resolved), and asks one seller for Copy to PatrolKit;
  - every choice audited.
- Adapter: `withRateLimitRetry` retries a 429, honors `Retry-After`, gives up after five tries, and doesn't retry other errors. `itemsBySku` returns only the swap's category. `upsertItems` sends 1,200 items as three batches, retries a version mismatch once with fresh versions, and reports a batch that still fails without losing the others.
- D14: the `not_in_square` filter and `squareSynced` treat a missing variation id as missing.

**Smoke** (`apps/api/scripts/smoke-swap-diagnostics.mjs`, test org only):
- Locally, with the stub adapter (`PAYOUTS_STUB=1` and `SMOKE_CATALOG_FILE`, a catalog file the API and the script share): a seeded swap shows one of each issue; each choice is applied once; Mark resolved keeps an issue left as is away on the next run, and accepts one fixed by hand in the stub's catalog; a second run shows only what's left.
- On production, in the test org, only if the test org has a Square sandbox connected. Check that before relying on it.

**Web:**
- The modal's grouping, wording and which choices each row offers, as a pure function from a run to its sections (`swapDiagnosticsView.ts`).
- The stale-run rule.
