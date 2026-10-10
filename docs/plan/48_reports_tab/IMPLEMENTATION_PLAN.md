# Plan 48: Reports tab — Sales check and Catalog check

**Status:** implemented on 2026-10-09 and deployed with Plan 47 (migration `20261022120000_sales_check`). Still open:
- **The Square Dashboard link paths** (Rollout step 1) aren't confirmed against a live session. They're in `square-links.ts`.
- **The smoke script** (`smoke-sales-check.mjs`) isn't written. The flows were checked by hand against the Square stub, and by unit tests.

## Goal

A **Reports** tab in the ski swap, beside Payouts, for the problems that today's first day of sales showed only a hand-run script could find. It has two sub-tabs:

- **Sales check** (new): every sale in Square that PatrolKit can't put on one of this swap's items. Each one says what happened, links to it in Square, and offers the fixes that apply, such as crediting the sale to the right item, or recording that it isn't a swap sale.
- **Catalog check**: the swap diagnostics (Plan 41), moved here from the modal on the Swaps tab, plus one new check for the problem behind most of today's mis-rung sales: a ticket number that another Square item also has, archived or not.

The dashboard gets one more issue card, "N sales need checking", linking to Sales check.

## Why

On 2026-10-09, 2,845 sale lines were rung up at the swap's location, and 116 of them weren't on this swap's items:

| Lines | What happened |
|---|---|
| 32 | A ticket scanned onto last year's archived copy of the same number (31), or onto a race duplicate (1, Plan 47). Square still scans archived items. |
| 7 | Staff made a new item at the register, named for a real ticket ("86882 roxa raven 2"), sometimes with a mistyped SKU ("E6882"). |
| 9 | A ticket number PatrolKit has no record of, sold on last year's copy or a register item. |
| 67 + 4 + 1 | Swag, custom amounts, an old CPR fee: not swap sales. |

For each of the first 39, the item still reads as unsold, the seller's page says it's for sale, and the payout won't pay the seller. Payouts list these sales only as raw "unmatched" order and variation ids, with nothing to act on. All of it came to light only because someone asked.

## What's already here

- **Tabs** (`SkiSwapLayout.tsx:162-253`, routes in `App.tsx:152-168`):
  - Three `NavLink` groups split by "|".
  - Dashboard, Items and Payouts are swap-scoped and need `ski_swap:report`.
  - The only sub-tab bar is `AdministrationLayout.tsx` (a nested `NavLink` row and an `<Outlet context>`).
  - The swap picker hides on routes matching the org-scoped regex at l.153-155.
- **Swap diagnostics** (Plan 41):
  - **UI:** `SwapDiagnosticsModal.tsx`, opened from each row of the Swaps tab, with copy in `swapDiagnosticsView.ts`.
  - **API:** under `…/swaps/:swapId/diagnostics`, all `ski_swap:admin`.
  - **Runs:** manual and in the background. Each reads the swap's Square category only, matched by SKU, against our live, deleted and returned items.
  - **Kinds:** `only_square`, `only_ours`, `differs`, `not_linked`, `twice`, `returned`. Each has its choices.
  - **Hide and audit:** fingerprints and "mark resolved" with hiding (`SwapDiagnosticHidden`), and an audit entry per applied choice.
- **Sales:**
  - `PosAdapter.listSales` gives one `PosSaleLine` per line: `orderId`, `variationId`, `quantity`, `collectedCents`, `unitPriceCents`, `refundedQuantity`, `soldAt`.
  - Every consumer matches a line to an item by `variationId` and nothing else. The consumers are the dashboard (`ItemBreakdownService`, cached two minutes), payouts (`build-run.ts`), seller and checkout totals, and public status.
- **Payouts:**
  - Unmatched lines are frozen on `PayoutRun.unmatchedSales` as `{variationId, orderId, collectedCents}`.
  - They're shown as an amber panel of raw ids on the run page, with no links and no actions.
- **Sold or not:**
  - Payouts and the dashboard count sale lines.
  - The items list, returns and the public pages read the item's Square stock (`getInventoryCounts`). A sale on another copy decrements the other copy's stock, so ours stays at 1.
- **Square links:** nothing links to the Square Dashboard yet.
- **Plan 47** (committed as `73fe86b`, deployed before this plan):
  - **The claim:** every path that creates a Square item claims it first (`square-create-claim.ts`), including diagnostics' "Copy to Square".
  - **The ticket push:** `IssuedTicketService.push(orgId, swapId, itemIds?)` pushes just those tickets and can be awaited.
  - **Link before creating:** the adapter links an item Square already has, active and in the swap's category, instead of creating it (`activeBySku`). It ignores archived items and other categories, which is exactly what `elsewhere` (D11) has to find.
- **Square catalog objects carry no creation time** in our SDK; only `version` and `updatedAt`.

## Decisions

| | Decision |
|---|---|
| D1 | **A Reports tab, swap-scoped,** after Payouts in the first group, needing `ski_swap:report`. It has two sub-tabs, **Sales check** (the default) and **Catalog check**, in the `AdministrationLayout` pattern. Viewing needs `ski_swap:report`; every fix needs `ski_swap:admin`, as diagnostics and payouts actions do now. |
| D2 | **The diagnostics move here.** The modal's content becomes the Catalog check page, at a URL, with the swap picker, so it's one click from the problems it explains. The Swaps tab's "Diagnostics" button becomes a link to it. The API is unchanged. |
| D3 | **Sales check reads live, with no run.** It's the same two-minute cached Square read as the dashboard, plus one `catalog.batchGet` for the variations it can't place, which covers both the variations and their items. Catalog check keeps Plan 41's manual runs, because it reads the whole category and takes minutes. |
| D4 | **A decision per sale line, not per variation.** A custom amount has no variation, and a register item could be sold more than once. `PosSaleLine` gains `lineUid` (Square's line `uid`), and a decision is keyed on `(orderId, lineUid)`. |
| D5 | **One attribution rule, shared by every consumer.** Each sale line goes to (1) the item whose variation it is, else (2) the item a decision credits it to, else nowhere. The dashboard, payouts, seller and checkout totals, and public status all use the same `attributeLines(lines, items, decisions)`, so a credited sale is a sale everywhere at once. |
| D6 | **Crediting also marks the item sold in Square** (on by default). It sets our variation's stock to 0, so the items list, returns, public pages and register agree. It only does this when that stock is still above what's been sold. |
| D7 | **"Not a swap sale" is recorded, not hidden.** The line drops out of Sales check and of a payout's unmatched list, and the decision is kept with who made it and when. A swap can also say whole Square categories are never swap sales (Swag, the patrol's fees): their lines never show. That's a short list of category ids on the swap, edited from Sales check. |
| D8 | **Suggestions, never guesses.** Sales check proposes an item when the evidence is exact: the line's Square SKU equals one of our ticket numbers (an archived or duplicate copy), or a register item's name or SKU contains exactly one of our ticket numbers. The proposal is a button; nothing is credited without a person pressing it. Anything else gets a search for an item by ticket or name. |
| D9 | **Unknown tickets can be issued from here.** For a ticket number PatrolKit has no item for, "Issue to a seller…" picks a seller, issues the ticket (Plan 38's `addTickets`), and awaits that ticket's own push (`push(orgId, swapId, [id])`, Plan 47). It then credits the sale to the ticket and marks it sold (D6), in one step. The push creates a fresh Square item: last year's archived copy is in another category and archived, so link-before-create ignores it. |
| D10 | **Links into Square.** Each issue links the Square item it involves and the sale. The base URL is per environment (`squareup.com` or `squareupsandbox.com`). The exact paths (item library by item id; a sale by its payment or order id) are verified on the real Dashboard before shipping (Rollout step 1). If one can't be deep-linked, the link opens the right Dashboard page with the id shown to copy. |
| D11 | **A new Catalog check kind, `elsewhere`:** one of this swap's ticket numbers is also the SKU of another Square item, outside the swap's category or archived inside it. Archived items still scan, which is what caused today's mis-rings. The run searches the whole catalog by this swap's SKUs (`catalog.search` on `sku`, 100 at a time, sharing Plan 47's lookup without its active-and-in-category filter). The choices: **Delete the other item**; **Re-number the other item's SKU**; **Mark resolved**. Re-numbering prefixes the old SKU, e.g. `2025-73789`, so its history keeps the number. Square gives no creation date, so the prefix is the other item's category name when that is a year ("2025"), otherwise a prefix staff type in once for the group. Delete and re-number refuse any item PatrolKit knows. Both work on the whole group through `apply-all`, so last year's 1,001 collisions are one action. |
| D12 | **Everything is audited** as diagnostics choices are: `ski_swap.sales_check.credited`, `.not_swap_sale`, `.issued_and_credited`, `.category_ignored`, and `ski_swap.diagnostics.applied` for `elsewhere`. |

### D13: Looking never changes anything; only a person's choice does

- **Sales check:** reading it (`GET`), and the dashboard card that counts it, only read: Square's sales (the same cached read as the dashboard) and `catalog.batchGet`. They write nothing to Square or to our database. The cache is in memory.
- **Catalog check:** a run reads Square (the category, and D11's SKU search) and writes only its own run and issue records, as Plan 41's runs do today. Nothing it finds is applied by itself.
- **Every change is a `POST` naming one choice for specific issues or lines,** made by an admin: credit, not a swap sale, undo, ignore a category, issue and credit, or one of Catalog check's choices. Each re-reads its line or issue first and refuses if it changed. Each is audited (D12).
- **"Credit all suggested"** sends the exact lines it showed in its confirmation. The server credits those lines and no others, even if new suggestions appeared since.
- **Suggestions are only labels on buttons** (D8). Nothing is credited, marked sold, deleted or re-numbered unless someone presses one.

### Naming the sub-tab

**Sales check** is what I'd call it: it pairs with **Catalog check**, says what it checks, and stays short in the tab bar. Alternatives considered:

- **Unmatched sales:** accurate, but it names the symptom, not the page.
- **Reconciliation:** right for the payout-review sense, but long for a tab, and accountant's language.
- **Problems / Issues:** too vague once Reports has more than one sub-tab.

## Sales check: what it shows

One list, grouped by kind. Each issue reads as a sentence, then its facts, its Square links, and its buttons.

| Kind | When | Explanation (shown) | Fixes |
|---|---|---|---|
| `other_copy` | The line's Square SKU equals a live ticket of this swap, but it's another item: archived, last year's, or a duplicate | "Ticket 73338 was scanned onto last year's archived copy, so this sale isn't on Karen Beckwith's item." | **Credit to Item #73338** (D8); Credit to another item…; Not a swap sale |
| `register_item` | The line is on a non-PatrolKit item whose name or SKU contains exactly one live ticket number of this swap | "This item was made at the register as '86882 roxa raven 2'. It looks like ticket 86882, Little Mountain's 'Roxa Raven 2 19.5'." | **Credit to 86882**; Credit to another item…; Not a swap sale |
| `unknown_ticket` | The line's SKU or name is a ticket-shaped number that no item of this swap has | "Ticket 59443 isn't in PatrolKit. It was sold on last year's copy for $10.00." | **Issue to a seller…** (D9); Credit to another item…; Not a swap sale |
| `custom_amount` | The line has no catalog item | "A custom amount of $250.00 was typed at the register." | Credit to an item…; Not a swap sale |
| `other_item` | Anything else: a non-swap item in a category not yet ignored | "Sold 'TShirt' (Swag), which isn't a swap item." | Not a swap sale; **Never count 'Swag'** (D7); Credit to an item… |
| `oversold` | An item is credited, directly or by decisions, with more units than its quantity | "Item #73308 is counted as sold twice: here and on order …" | Undo either credit |

**Each issue shows:**
- **The sale:** time, order, amount collected, and price as rung up.
- **The item it went on:** its name, SKU and category, and whether it's archived.
- **The proposed PatrolKit item:** its seller and price, and whether it's unpriced.
- **Links:** "Open in Square" for both the sale and the item.

**The header** shows counts and dollars per kind, "from Square as of 4:52 PM", and "Credit all suggested". That applies D8's exact suggestions in one go, after a confirmation listing them.

**Credited and "not a swap sale" lines** move to a collapsed "Decided" list, each with **Undo**. Undoing re-opens the line. It never touches Square stock: if stock was zeroed, the undo says so and offers "Put back in stock" as a separate button.

## Server

- **Schema** (additive migration):
  - **`SwapSaleDecision`:**
    - Fields: `id`, `swapId`, `orgId`, `orderId`, `lineUid`, `decision` (`CREDIT` | `NOT_SWAP`), `itemId?`, `collectedCents`, `variationId?` (as seen), `note?`, `decidedBy`, `decidedAt`, `undoneAt?`, `undoneBy?`.
    - Unique on `(swapId, orderId, lineUid)` among live rows (MySQL needs a mirror column, as `liveSku` does).
  - **`SkiSwap.ignoredSquareCategoryIds`:** `Json?`, a string array.
- **`PosSaleLine.lineUid`:** set from `line.uid` in `square.pos.adapter.ts listSales`, and filled by the stub from the sales file. The payout freeze adds it to `unmatchedSales`.
- **`attributeLines`** (new, pure): takes `(lines, itemsByVariation, decisions)` and returns `{ itemId | null, via: 'variation' | 'credit' | 'not_swap' | null }` per line. It's used by:
  - `ItemBreakdownService`: the breakdown, the heat map, sold by category, seller and checkout totals;
  - `build-run.ts`: payouts. Credited lines pay as sales; `NOT_SWAP` lines leave `unmatched`;
  - `public-seller.service.ts` and `public-status.service.ts`, wherever they count sales.
- **`SalesCheckService`:**
  - `list(orgId, swapId)`:
    1. Takes the cached lines and attributes them.
    2. For lines with no item and no decision, `batchGet`s their variations and items, in 1,000s.
    3. Classifies by the table above, with suggestions.
    4. Skips ignored categories.
  - `credit(lineKey, itemId, { markSold })`:
    1. Re-reads the line from Square (a fresh `orders.retrieve`).
    2. Refuses if the line is already credited or the item is already sold out (the `oversold` guard).
    3. Writes the decision; if `markSold`, sets stock with `setInventoryPhysicalCount(variation, location, max(0, stock − units))`.
    4. Clears the swap's sales cache and audits.
  - `notSwapSale(lineKey, note?)`, `undo(decisionId)`, `ignoreCategory(categoryId)` and `issueAndCredit(lineKey, sellerId, sku)`. The last issues the one number to the seller and awaits `IssuedTicketService.push(orgId, swapId, [itemId])` (Plan 47), then credits. If the push failed, it says so and credits nothing; the ticket stays issued for a retry.
  - `creditAllSuggested(runOfKeys)` is the same as `credit`, per key, reporting per line.
- **Controller:** `orgs/:orgId/ski-swap/swaps/:swapId/sales-check`:
  - `GET /` (`report`);
  - `POST credit`, `not-swap`, `undo/:id`, `ignore-category`, `issue-and-credit`, `credit-suggested` (`admin`);
  - all idempotent on an `Idempotency-Key`, as batch tickets are.
- **Diagnostics `elsewhere`** (D11):
  - In the run, after the category read, `itemsBySkuAnywhere(skus)` (`itemsBySku` without the category filter, archived included) finds the copies outside the category. `diagnose()` gains the kind.
  - The choices in `perform()`:
    - `delete_other`: `catalog.object.delete` on the other item id, refused if PatrolKit knows that id;
    - `renumber_other`: re-upsert the other item at its current version with each variation's SKU prefixed (D11's prefix: its category's name when that's a year, else the one staff gave);
    - `resolve`.
- **Square links** (`square-links.ts`): `squareItemUrl(env, itemId)` and `squareSaleUrl(env, orderId, paymentId?)`, with the paths fixed by Rollout step 1. Sales check returns ready-made URLs, so the web needs no Square knowledge.

## Web

- **`SkiSwapLayout.tsx`:** add a **Reports** `NavLink` after Payouts (`report`).
- **`App.tsx`:** add `ski-swap/reports` → `ReportsLayout` (a sub-tab bar like `AdministrationLayout`), with the children `sales` (index) and `catalog`.
- **`SalesCheckPage.tsx`:**
  - the header with counts, the time it was read, and "Credit all suggested";
  - groups by kind, then issue cards, then the "Decided" list;
  - the item search ("Credit to another item…") reuses the Items page search endpoint;
  - the seller picker ("Issue to a seller…") reuses the batch tickets seller picker.
- **`salesCheckView.ts`:** group titles, explanations, choice labels and order, as `swapDiagnosticsView.ts` does, with tests.
- **`CatalogCheckPage.tsx`:**
  - the body of `SwapDiagnosticsModal` as a page, for the selected swap, with `elsewhere`'s copy and choices added;
  - the modal is removed, and the Swaps row's button links to `reports/catalog` with that swap selected.
- **Dashboard:** an issue card, "N sales need checking", shown when `list` has open issues and linking to `reports/sales`. It's admin only, as the fixes are.
- **Payout run page:** the "N unmatched sales" panel links to Sales check. Sales decided there are no longer unmatched on the next run.

## Tests

- **Reading is read-only (D13):**
  - `GET sales-check`, run against a Prisma fake and a Square fake that throw on any write (`create*`, `update*`, `delete*`, `upsert`, `batchUpsert`, `batchCreateChanges`, `object.delete`, `batchDelete`), succeeds and returns its issues;
  - the dashboard card's count, the same;
  - a Catalog check run writes only `SwapDiagnosticRun` and `SwapDiagnosticIssue` rows: the Square fake throws on any write, and the Prisma fake on any write to another table;
  - every Sales check and Catalog check route that changes something is a `POST` needing `ski_swap:admin`. A route-access spec lists them, so a new one can't arrive unguarded.
- **"Credit all suggested"** credits exactly the lines sent, not a recomputed set.
- **`attributeLines`:**
  - a direct variation;
  - a credit;
  - a not-swap line;
  - an undone decision (the line is unmatched again);
  - a line whose item was deleted after the sale.
- **Classification:**
  - an archived twin → `other_copy` with its suggestion;
  - "86882 roxa raven 2" → `register_item` → 86882;
  - a name with two ticket numbers → no suggestion;
  - an unknown 59443 → `unknown_ticket`;
  - a custom amount;
  - an ignored category is skipped;
  - `oversold`.
- **Credit:**
  - re-reads the line;
  - refuses a second credit for the line;
  - refuses past an item's quantity;
  - zeroes stock only when it's above the units sold;
  - clears the cache;
  - is audited.
- **Payouts:** a credited line pays its seller at the price Plan 32's rules give (PatrolKit's price, or the typed price for an unpriced ticket); a not-swap line leaves `unmatched`.
- **Issue and credit:** issues the number to the seller, pushes it to Square, and credits the line; refuses a number another seller holds.
- **Diagnostics `elsewhere`:**
  - found for an archived item in another category;
  - `delete_other` refuses an item PatrolKit knows;
  - `renumber_other` prefixes every variation's SKU and keeps the item id;
  - the prefix comes from a year-named category, else the one given;
  - `apply-all` over a group of 1,000 works in batches and reports per item.
- **Web:** `salesCheckView.ts` ordering and labels; Reports tab permissions (a `report`-only user sees Sales check without fix buttons).
- **Smoke** (`smoke-sales-check.mjs`, `patrolkit-smoke`, `PAYOUTS_STUB=1`):
  - A sales file with a twin, a register item, an unknown ticket and a custom amount: each appears with the right kind.
  - Crediting moves the dashboard's sold count and a payout's line.
  - "Not a swap sale" removes a line from `unmatched`.

## Rollout

0. **Deploy Plan 47 first** (its own additive migration), so no new duplicates appear while this is built.
1. **Verify the Square Dashboard URL formats** for an item and a sale, on the production Dashboard, and fix them in `square-links.ts`.
2. **Migrate** (additive): `SwapSaleDecision` and `SkiSwap.ignoredSquareCategoryIds`.
3. **Deploy.** Sales check then lists 2026-10-09's 116 lines:
   - 39 with a suggestion (32 `other_copy`, 7 `register_item`);
   - 9 `unknown_ticket` for staff to trace;
   - the rest are swag, fees and custom amounts. Ignore "Swag" once, and decide the custom amounts.
4. **Run Catalog check.** `elsewhere` lists the ticket numbers still shared with last year's archived items. Delete or re-number them there; this replaces the one-off deletion discussed on 2026-10-09.
5. **Before the next sales day,** confirm both lists are empty or decided, and that the dashboard card is gone.

## Out of scope

- **Checks on a schedule, or alerts:** a later plan, once the lists have earned trust.
- **Moving a sale in Square itself:** Square can't re-point a completed order's line to another item; PatrolKit records the credit instead.
- **Duplicates created by the ticket push race:** fixed by Plan 47. Any made before it show as Catalog check's `twice` (still active) or `elsewhere` (archived), and sales on them as Sales check's `other_copy`.
- **Price corrections** (a sale rung up below PatrolKit's price): payouts' discount report covers them; a "Price correction" discount is a separate idea.
- **Other report sub-tabs** (payout summaries, seller statements): Reports leaves room for them.
