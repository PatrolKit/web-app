# Plan 45: Batch set category

## Goal

Staff pick a category, and as many of its details as they like, then scan a pile of tags. Every scanned item that has no category gets that category and those details. Nothing else about it changes, unless staff turn on **Rename items** (off by default), which also gives it the name the category and details derive. An item that already has a category is skipped.

It has to keep up with a scanner in continuous mode, so scans go into a queue and are sent in small batches. It's best effort: a scan that can't be applied is shown and sounded, and the session carries on.

It's for the imported and issued items that arrived as `Item #67169` with no category. Once categorized, they appear in the right place on the dashboard and in reports, and staff can add details later.

## What's already here

- **Categories.** `SwapItem.categoryId` points at a CATEGORY node. Answers are `SwapItemAttribute` rows (`attributeId`, `valueId` or `numberValue`). An item with no category carries no answers (iOS Plan 20).
- **Validation.** `TaxonomyService.resolveAnswers(orgId, categoryId, inputs)` checks that every answer belongs to the category and is reachable from the values picked, including through "same details as" (Plan 44). It also derives a name. Free text (`freeText`) mints a new value.
- **Editing.** `ItemService.patch` with `categoryId` and `attributes` replaces the answers and **re-derives the name** unless one is sent. That's why this plan has its own write.
- **The picker.** `ItemDescriber` renders any category's questions, nested values and deferred lists included. Its state is `DescriberState { categoryId, answers }`, and `toAttributeInputs` turns it into the server's shape.
- **Scan screens.** Return items (Plan 43), Batch add and Scan ticket share `ScanSessionParts.tsx`: `ScannerBanner` (the connection widget), `Banner` (ready, warn, error) and `errorTone()`. The pure session logic lives beside each modal. Scans arrive through `ScannerContext.subscribe`.
- **Items page Actions:** Scan ticket, Batch add to seller, Return unused tickets, Return items to sellers, Import for a seller.

## Decisions

| # | Decision |
|---|---|
| D1 | **Only uncategorized items change.** A live item (not deleted) in the swap with `categoryId` null gets the category and the answers. An item with a category is skipped, whatever it is. Nothing else changes: not the price, description, seller, quantity, printed flag or acceptance, and not the name unless **Rename items** is on (D14). Off, the name stays as it is (`Item #67169`) and Square isn't touched. |
| D2 | **Any item in the swap,** whatever its state: waiting, accepted, sold or returned. A category is a description, not a sale. |
| D3 | **The pick: a category and any of its details,** in the same picker as the item form, but **picks only.** No typed values, because one typo would be applied to every item scanned. Number questions (Max DIN, length) can be answered. The pick can change during a session. Each scan keeps the pick it was made under. |
| D4 | **Scanner only.** The popover needs a connected scanner (`ScannerBanner`). There's no typed-SKU field: a tag that won't scan gets its category from the item's own edit form. A scan before anything is picked is refused, with the error tone: "Pick a category first." |
| D5 | **A queue, sent in batches.** A scan goes into the session's queue at once, as a row reading "Waiting". One request is in flight at a time. It carries up to 25 waiting scans that share a pick. When it lands, the next one goes. In continuous mode that means each request carries whatever arrived during the last one: one scan when it's quiet, a dozen during a burst. Order doesn't matter; throughput does. |
| D6 | **Repeats.** In continuous mode a scanner reads a held tag again and again. The same SKU within 3 seconds of its last scan is dropped silently. Later, it's a row reading "Already scanned this session", answered locally with no request. |
| D7 | **Best effort.** Every scan ends in a row and a sound. Nothing stops the session.<br>• **Set:** green. "Set to Skis · Bindings included: Yes".<br>• **Skipped:** amber. "Already a Boots item".<br>• **Not found:** red. "No item has this SKU in this swap".<br>• **Failed:** red, with the server's sentence (for example, the pick no longer exists because someone retired a value mid-session).<br>• **No connection:** the batch's rows go back to waiting, and the queue retries with backoff (1, 2, 5, 10 seconds, then every 10). The banner reads "Can't reach PatrolKit: N waiting, retrying". Nothing is dropped. Closing the popover with scans waiting asks first. |
| D8 | **Sound, as results land, not as scans arrive.** The scanner already beeps on a read, so the app's sound reports what happened.<br>• **Set:** one short high beep.<br>• **Skipped:** two quick mid beeps.<br>• **Not found:** a klaxon (`klaxonTone`), a second of two-tone wail: that tag needs someone to look at it now.<br>• **Failed:** the existing low double (`errorTone`).<br>A batch that lands plays one sound: the worst outcome in it. A burst of results doesn't become a burst of noise, and an error is never drowned out. |
| D9 | **Undo, per row,** for a row that was set. It clears that item's category and answers, but only if they're still exactly what this session set. If anyone has changed them since, it's refused ("Changed since: edit it instead"). The name is untouched, unless the row renamed it (D14). |
| D10 | **The write is conditional.** "Set where `categoryId` is still null", in one transaction with the answers. An item categorized by someone else in the meantime (the item form, an iPad) answers Skipped, never overwritten. |
| D11 | **Who.** `ski_swap:manage`, staff on the web (`@NoDeviceAccess`), like the other batch tools. |
| D12 | **Audited:**<br>• one `ski_swap.items.categorized` per batch, with the category, the answers and the item ids set;<br>• `ski_swap.item.category_cleared` per undo. |
| D13 | **The iPads need nothing new.** Setting a category moves `updatedAt`, so the walk delivers the category, the answers and any new name as for any edit. |
| D14 | **Rename items: a toggle, off by default,** beside the pick.<br>• **What it does:** a set item also gets the name `resolveAnswers` derives from the pick, the same name the item form would give it, US boot sizes included.<br>• **Every item in a batch gets the same name,** because they share one pick. A shallow pick names them all "Skis"; a deeper one names them "Marker Skis". The toggle's line says so: "Names each item from the category and details above, e.g. Marker Skis".<br>• **Per scan,** like the pick: each scan keeps the toggle it was made under, and a batch never mixes them.<br>• **Square:** a renamed item that's in Square is pushed again after the write, so the register shows the new name. The push is serialized per item, fire-and-forget and logged, as on any save. A failed push leaves the rename standing, and Diagnostics' "Name differs" raises it.<br>• **Printed tags keep the old name.** The printed flag isn't touched. The row says "Renamed from Item #67169", and Batch print on the Items page reprints if wanted.<br>• **Undo** also puts the old name back, if the name is still the one this session gave it, and pushes that to Square. |

## Server

### Contracts (`ski-swap.contracts.ts`)

- **Answers:** `CategorizeAnswerSchema` is `ItemAttributeInput` without `freeText`, so picks only (D3).
- **Request:** `CategorizeItemsSchema { categoryId, attributes: CategorizeAnswer[] (≤24), rename: boolean (default false), skus: string[1..25] }.strict()`.
- **Response:** `CategorizeItemsResponse { results: { sku, outcome: 'set' | 'skipped' | 'not_found', item?: { id, name, previousName, sellerName, categoryLabel } }[] }`, one per distinct SKU, in request order. `previousName` is set only when the item was renamed.
- **Undo:** `UncategorizeItemSchema { categoryId, attributes, rename?: { from, to } }`: what the session set, and the rename it made.

### Service (`ski-swap/item-categorize.service.ts`, new)

- **`categorize(orgId, swapId, input, actorId)`:**
  1. Validate the pick once with `resolveAnswers(orgId, categoryId, attributes)`. If it's invalid, the whole batch fails with the server's sentence (400).
  2. Find the batch's live items by `liveSku` in one query.
  3. Per item:
     - missing → `not_found`;
     - already has a category → `skipped`, with the category's label;
     - otherwise, in one transaction: `updateMany({ where: { id, categoryId: null, deletedAt: null }, data: { categoryId, ...(rename ? { name: derived } : {}) } })`, then `createMany` of the answer rows when the count is 1. A count of 0 → `skipped`.
  4. Audit once (D12), with each renamed item's previous name.
  5. With `rename`, push each renamed item that's in Square through `ItemService.syncToPos`, after the batch is answered and not awaited (D14).
  - Without `rename`, it never touches `name` and never calls Square.
- **`uncategorize(orgId, swapId, itemId, expected, actorId)`:**
  - Refuse `NOT_FOUND`, or `CHANGED_SINCE` (409) unless the item's `categoryId` and its set of answers equal `expected`.
  - Otherwise clear both in one transaction, conditional on `categoryId` still being the expected one.
  - With `rename`: restore `from` when the name is still `to`, then push to Square. A name changed since is left as it is, and the answer says so.
  - Audit.

### Routes (`item.controller.ts`, before `:itemId` routes)

- `POST …/swaps/:swapId/items/categorize`: `CategorizeItemsDto`. `ski_swap:manage`, `@NoDeviceAccess`.
- `POST …/swaps/:swapId/items/:itemId/uncategorize`: `UncategorizeItemDto`. Same guards.

No migration.

## Web

- **`ItemsPage.tsx`:** Actions gains **Batch set category** (staff with manage), opening the popover.
- **`ItemDescriber.tsx`:**
  - A `typedValues?: boolean` prop (default `true`). With `false`, the "type a value" path is hidden on every question (D3).
  - The popover passes `typedValues={false}`.
  - An `onPreview({ name, summary })` callback reports the name the answers derive and a one-line summary ("Skis · Type: Carving · Bindings included: Yes"), using the labels the form has loaded, deferred lists included. The popover uses them for the collapsed pick and the Rename line.
- **`BatchSetCategoryModal.tsx`** (new), from the scan screens' parts:
  - **Header:** "Batch set category" and **Done**. Done asks first when scans are waiting.
  - **`ScannerBanner`:** "Scan tags to set their category" when connected; the usual not-connected states otherwise, with `typed={false}` so they don't offer typing a number.
  - **The pick:** `ItemDescriber`, with **Use this** to collapse it to its one-line summary once a category is chosen, and **Change** to open it again. Scans are taken while it's open too. Changing it affects only scans from then on.
  - **Rename items:** a toggle under the pick, off. On, it shows the name the pick derives ("Names each item: Marker Skis"), worked out on the client the way the item form previews it. Like the pick, it applies to scans from then on (D14).
  - **The latest result on a `Banner`** (D7), with its sound (D8).
  - **Counts:** "Set 42 · Skipped 7 · Not found 2 · Waiting 3".
  - **The session's list, newest first:**
    - each row: SKU, name, seller, and the outcome as a badge; a renamed row adds "Renamed from Item #67169";
    - a set row has **Undo** (D9), which becomes "Undone";
    - a waiting row shows "Waiting" until its batch lands.
- **`batchCategoryLogic.ts`** (new, pure):
  - `scanned(state, sku, pick, rename, now)`: queue it, drop a repeat within 3 seconds, or answer "Already scanned".
  - `nextBatch(state)`: up to 25 waiting rows that share a pick and a rename setting.
  - `landed(state, batch, results)`, `failed(state, batch, error)`, `retryDelay(attempt)`.
  - `counts`, `bannerFor(row)`, `toneFor(results)` (the worst outcome), `pickSummary(tree, pick)`.
- **The drain loop:** a `useEffect` in the modal. While a request is in flight, new scans just queue. When it lands, send the next batch, if any. When a request fails without an answer, wait `retryDelay` and try again.
- **`ScanSessionParts.tsx`:** add `successTone()` and `skipTone()` beside `errorTone()`, from the same `AudioContext`-made beep.
- **`ScannerContext.tsx`:** in development only, `window.__patrolkitScan('67169')` delivers a scan as a scanner would, so a scan screen can be driven with no hardware. It's not in a production build.
- **`lib/api.ts`:** `skiSwap.categorizeItems` and `skiSwap.uncategorizeItem`, with their types in `api.types.ts`.

## Tests

- **`item-categorize.service.spec.ts`:**
  - sets the category and answers and leaves the name, price, seller and Square alone;
  - with `rename`, gives each set item the derived name (boot sizes included), records the previous one, and pushes it to Square; a skipped item keeps its name;
  - skips an item with a category and says which;
  - answers not found;
  - a race (the conditional write finds a category) answers skipped;
  - an invalid pick fails the batch;
  - free text is refused by the contract;
  - repeated SKUs in a batch are answered once;
  - audited once per batch.
- **Undo:** clears exactly what was set; refused once anything changed; leaves the name, or with a rename restores the old one unless the name was changed since.
- **`batchCategoryLogic.test.ts`:**
  - a repeat within 3 seconds is dropped, later it's "Already scanned";
  - batches never mix picks or rename settings, and never exceed 25;
  - a failed batch goes back to waiting, and the retry delay grows and caps;
  - counts;
  - the tone is the worst outcome;
  - a scan with no pick is refused.
- **`scripts/smoke-batch-category.mjs`** (test org): a batch with an uncategorized item, a categorized one and an unknown SKU, which answers set, skipped and not found. The item's name and price are unchanged, and undo works. A second batch with `rename` renames the item, and its undo restores the name.

## Rollout

1. Build and test locally, including a run through the popover on a copy of the database: a burst of scans while a batch is in flight, a repeat, an already categorized item, an unknown tag, the server stopped mid-session (rows wait, then land), and an undo.
2. Deploy, after asking. No migration.
3. Smoke in the test org.

## Out of scope

- Reprinting tags (Batch print does it), or changing the printed flag.
- Changing an item's existing category (that's the item form).
- The iPad.
- A typed SKU.
