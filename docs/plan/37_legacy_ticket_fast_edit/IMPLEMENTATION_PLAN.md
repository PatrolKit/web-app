# Plan 37: Legacy ticket fast edit

## Goal

Staff work through a stack of legacy ticket stubs, each with a SKU, a
description and a price, and enter them as fast as they can type, without
touching the mouse.

A **Fast Edit Tickets** button on the Items screen opens a dialog with three
fields in a row. For each stub:

1. **SKU** (focused): type the ticket number. It autocompletes from this swap's
   tickets that have no price yet. Required.
2. **Tab → Details:** what the item is. It autocompletes from the item
   taxonomy (type, manufacturer, color…), and free text is allowed. Optional.
3. **Tab → Price:** required.
4. **Enter** saves the ticket, clears the form and puts the cursor back in SKU.

An **Exit** button closes the dialog.

No iPad changes. No migration.

## Decisions

| # | Decision |
|---|---|
| D1 | **Only unpriced tickets.** The SKU must be a ticket in this swap that's checked in, live and has no price. Anything else is refused in the field, saying why: "67169 isn't checked in to this swap", "67169 already has a price ($45.00)", or "AB-0012 isn't a legacy ticket". Nothing is created; the cursor stays in SKU. Correcting a priced ticket is the Items list's Edit, as today. |
| D2 | **Details are structured where they match, and read as typed.** Words that match the taxonomy become the item's category and attribute answers. The item's name is the line as typed, with matched words in their proper spelling and leftovers kept: "rossignol red skis 170 demo" is stored as Skis, Manufacturer Rossignol, Color Red, and named "Rossignol Red Skis 170 demo". |
| D3 | **Matching rules:** |
| | • **The category decides the rest.** A category word anywhere in the line ("skis") sets it. Values match only that category's attributes (Color on Skis isn't Color on Jackets). |
| | • **A value picked before any category brings its category.** Picking "Rossignol — Skis manufacturer" from the suggestions sets Skis. If "Skis" isn't in the line, it's added to the end of the name. |
| | • **No category, no structure.** With no category word and no picked value, the whole line is the name, and the item's category is left as it was. |
| | • **One answer per attribute.** A second color stays as text in the name. |
| | • **Longest match first,** whole words, ignoring case: "Black Diamond" beats "Black". |
| | • **Nothing is minted.** Leftover words go to the name, never into the taxonomy as new pending values. |
| D4 | **A loaded ticket shows its current description.** Tabbing past leaves it unchanged; editing it re-reads the whole line under D2. A placeholder name ("Item #67169") shows as empty. Emptying the field also leaves the description unchanged: nothing in this dialog clears one. |
| D5 | **Keys:** |
| | • **SKU:** Enter or Tab loads the ticket on an exact match, or on a suggestion picked with the arrow keys. A partial number never loads its first suggestion by accident. |
| | • **Details:** Enter takes the highlighted suggestion. With no suggestions open, Enter moves to Price. Tab moves to Price, taking a suggestion first only if one was arrowed to. |
| | • **Price:** Enter saves, once SKU and Price are valid. |
| | • **Everywhere:** ↑ and ↓ move through suggestions, and Shift+Tab goes back a field. Escape closes the suggestions; with none open, it clears the current ticket and returns to SKU. Escape on an empty form closes the dialog. |
| D6 | **A save never overwrites a price.** It's sent with `ifUnpriced`, so a ticket priced meanwhile (on another screen, or written back from the register by a payout run) is refused, saying what it's priced at, and the form keeps what was typed. |
| D7 | **What a save sends:** the price, plus the category, answers and name only if Details changed. It never sends notes, quantity, seller or donation, so nothing else on the item moves. Setting the price puts an accepted ticket on sale in Square at that price at once, as pricing it from Edit does today. |
| D8 | **Who and where:** staff with `ski_swap:manage`, on the Items screen, for the swap it shows. The button appears when the swap takes legacy tickets anywhere, or has unpriced tickets. It shows how many still need a price, and is disabled at zero. |

## Server

### Unpriced tickets (`item.controller.ts`, `item.service.ts`)

`GET /orgs/:orgId/ski-swap/swaps/:swapId/items/unpriced-tickets`, needing
`ski_swap:manage`:

```jsonc
[{ "id": "…", "sku": "67169", "name": "Item #67169", "placeholderName": true,
   "categoryId": null, "sellerName": "Stowe Sports" }]
```

- **Rows:** live items in the swap with a ticket SKU (`TICKET_NUMBER`) and
  `priceCents: null`, ordered by number.
- **Light:** no Square inventory lookup and no photos. It's an autocomplete
  source, fetched when the dialog opens.
- **`placeholderName`:** the name is still `uncategorisedName(sku)`, for D4.

### The guard on patch (`PatchItemSchema`, `ItemService.patch`)

- **`ifUnpriced?: true`:** an item with a price is refused with `409`,
  `code: "TICKET_PRICED"`, "67169 already has a price ($45.00)." The check and
  the write happen in one transaction, so two saves can't both pass it.
- **Nothing else changes.** `name` alongside `categoryId` and `attributes` is
  already accepted: the redescribe sets the answers, and `name` replaces the
  derived name.

### Refusal reasons

The SKU field's refusals (D1) come from the existing `GET …/items/by-sku/:sku`:
- **404:** "isn't checked in to this swap";
- **a price:** "already has a price";
- **not a ticket SKU:** "isn't a legacy ticket".

## Web

### The button (`ItemsPage.tsx`)

In `toolbarExtra`, beside "Import for a seller": **Fast Edit Tickets (N)**,
per D8. It opens the dialog for the panel's swap.

### The dialog (`TicketFastEdit.tsx`, new; its logic in `fastEditLogic.ts`)

- **Layout:**
  - SKU, Details and Price on one row, with suggestions under the focused field.
  - Under the row:
    - **The loaded ticket:** seller, and its current name.
    - **Details preview:** what will be stored, "Skis · Manufacturer Rossignol ·
      Color Red", and the name, "Rossignol Red Skis 170 demo".
    - **Refusals and errors.**
- **Suggestions:**
  - **SKU:** unpriced tickets whose number starts with what's typed, up to 8,
    each with seller and current name.
  - **Details:** for the word being typed.
    - **Before a category:** categories first, then values, each labeled with
      what it is ("Rossignol — Skis manufacturer").
    - **After one:** that category's values.
- **Saving, in the background:** the form clears to SKU the moment Enter is
  pressed, so the next stub can be typed while this one saves. Each save has
  its own Idempotency-Key.
  - **Its result:** on its own line, apart from anything about the stub being
    typed: "Saved 67169 · Rossignol Red Skis · $45.00".
  - **Saved, but not in Square:** it says so, as the Items list does. The
    ticket is priced; re-push from Items.
  - **A refusal (D6) or error:** "67169 wasn't saved: …". A ticket priced
    elsewhere leaves the suggestions; anything else goes back, to enter again.
  - **Exit** waits for saves still on their way, so the Items list refreshes
    with them.
- **This session:** a running list of what was saved, newest first, and a
  count: "12 priced · 140 left".
- **Exit:**
  - The button, or Escape on an empty form.
  - Anything typed but unsaved is dropped.
  - On close, the Items list refreshes.
- **Focus** moves right after React's render, never a frame later, so a fast
  typist's next key can't land in the field being left. A loaded ticket's
  prefilled description offers no suggestions until something is typed.
- **Loading:**
  - Unpriced tickets, when the dialog opens.
  - The taxonomy once, at `?depth=full`, so manufacturers' model lists are
    there to match without a request per keystroke.
- **Price input:** the Items form's sanitizing and `formPriceCents`, moved to
  `lib/money.ts` as `priceInput` and `priceInputCents` and shared. Positive
  amounts only.

### Logic kept pure, for tests

- **`parseDetails(text, picks, taxonomy)`:** D2 and D3. It returns
  `{ categoryId, attributes, name }`, or `null` for "no change".
- **`fastEditKeys(state, key)`:** D5's moves, as a reducer the dialog drives.

## Rollout

1. **No migration.** The endpoint and the patch field are additive, and an
   older client never sends `ifUnpriced`.
2. **Verify on production** with `smoke-ticket-fast-edit.mjs`, in the smoke
   org only:
   - **Listing:** unpriced tickets in number order, leaving out priced,
     non-ticket and withdrawn items.
   - **Saving:** a price with a category, answers and name override, read back
     as stored.
   - **`ifUnpriced`:** refused on a priced ticket, with its price in the
     message.
3. **Try it on BMBWAV's swap** with a few real stubs, after the deploy.

## Tests

- **`parseDetails`:**
  - category first or last;
  - values before a category;
  - a value picked before a category, with that category added to the name;
  - multi-word values, and longest match first;
  - a second answer for the same attribute staying in the name;
  - no category leaving the line as the name;
  - an unchanged prefill giving `null`;
  - case and spelling restored for matched words.
- **`fastEditKeys`:** every key in every field, including an exact SKU versus a
  prefix, Enter with and without suggestions open, and Escape's three steps.
- **Unpriced list:** filters and order.
- **Patch with `ifUnpriced`:** refuses a priced ticket, and allows an unpriced
  one.
- **Name override with redescribe:** the stored name is the override, and the
  answers are the picks.
