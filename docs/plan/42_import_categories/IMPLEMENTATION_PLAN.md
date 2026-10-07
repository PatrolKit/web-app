# Plan 42: Categories and item details in a CSV import

## Goal

A seller's spreadsheet can say what each item is. Alongside `ticket`, `name`, `price` and `description`, a CSV import takes a `category` column and one column per item detail (`Manufacturer`, `Model`, `Size`, `Length`, `Color`…). Each cell is matched against our categories and values, so imported items are described the way the iPad and the item form describe them: they show in "Items by category", filter by detail, and carry their answers.

Nothing is guessed and nothing is minted. A value we don't have is reported, not created. A new **Check file** step lists every unknown value before anything is written. A file imports only once it checks clean: staff add the missing values (globally or for the patrol) and check again.

The first file through it is a shop's 1,128-item spreadsheet (BMBW, tickets 86828–88019). Its conversion to this format is a one-off at the end of this plan.

## What's already here

- **Two uploads, one importer.** Staff's "Import for a seller" (`ProxyItemImportModal.tsx` → `POST …/swaps/:swapId/items/import` → `ItemService.importForSeller`) and a shop's own upload (`TicketItemImportModal.tsx` → `POST …/seller/me/items/import` → `SellerSelfService.importItems`) share `LegacyTicketService.parseItemCsv`, `checkImportRows` and `ItemService.importItems`.
- **The CSV today:** `sku`/`ticket`, `name`, `description`, `price`, with aliases, case-insensitive. Unknown columns are ignored. No category or details: Plan 19 D12 left CSV as free text.
- **Checked whole, then written in the same request.** Any error refuses the file with every error listed by line; otherwise it's written. There's no step that checks without writing.
- **Writing.** A ticket row fills in an issued ticket through `patch`; a row without a ticket is a `create`. Square follows in the background, in batches (`pushImported`).
- **Describing an item.** `patch`/`create` take `categoryId` and `attributes: { attributeId, valueId?, numberValue?, freeText? }[]`. `TaxonomyService.resolveAnswers` validates them against the org's tree and composes the name. `freeText` mints a new value (pending unless approved). An explicit `name` (patch) or `printedName` (create) is kept as the name, and the answers are stored alongside.
- **The tree.** Global categories, plus patrol-level ones. Each category has details: select (a list of values; Model hangs under its Manufacturer value), or number (Length, Mondopoint, Flex, with an optional range and unit). `TaxonomyService.resolve(orgId)` returns the approved tree.
- **Fast Edit** matches free text against the tree (`parseDetails`), whole words, longest label first. That's for one typed line; a file has columns and doesn't need it.

## Decisions

| # | Decision |
|---|---|
| D1 | **The format.** Two new kinds of column, both optional, both case-insensitive:<br>• `category`: one of the org's categories by its label. A trailing "s" is ignored, so "Ski boot" finds "Ski boots".<br>• **A detail column**, headed with the detail's label: `Manufacturer`, `Model`, `Size`, `Length`, `Mondopoint`, `Color`, `Gender`, `Condition`, `Bindings included`, `Style`, `Holds`…<br>A file without either column imports exactly as today. |
| D2 | **Details are read per row, against that row's category.** One file can mix boots, skis and jackets. A detail column the row's category doesn't have, and an empty cell, are skipped without comment. A detail column no category has at all ("Colour") is reported once for the file. |
| D3 | **Matching a value.**<br>• **Select:** the value's label, trimmed, case-insensitive. Approved values only, global and the patrol's.<br>• **Nested:** a detail that hangs under a value (Model under its Manufacturer) is matched only among that value's children. A Model without a matching Manufacturer on the row is unknown.<br>• **Number:** the leading number, with units stripped ("163", "163cm", '42"', "24.5"). Outside the detail's range is unknown.<br>No aliases: "Rossi" doesn't find "Rossignol". A file is fixed by its maker, or the value is added. |
| D4 | **A file imports only when it checks clean.** An unknown category or value, or an unrecognized column, refuses the file like any other error, with nothing written. They're listed apart from the row errors, grouped (D6), because the fix is usually adding a value rather than editing the file. |
| D5 | **Never minted.** The importer never sends `freeText`, so no file creates a value, pending or approved, whoever uploads it. Adding values stays a deliberate act in Item details. |
| D6 | **Check file.** Both uploads get a **Check file** button beside Import. It runs the whole import (parse, ticket checks, matching) and writes nothing. It shows:<br>• errors by line, as now;<br>• **unknown values grouped**: "Ski boots · Manufacturer · Alpina · 31 rows", "Skis · Model · Mantra 84 (Volkl) · 4 rows", with the lines on expand;<br>• unknown categories and unrecognized columns;<br>• what will be written: "1,128 tickets described, 1,071 with a category".<br>The list can be copied, to hand to whoever adds the values. Import is disabled until a check comes back clean, and the server refuses an unclean file regardless (D4). |
| D7 | **The name.** A row with a `name` keeps it as the tag name, and the details are stored alongside (ticket rows: `patch` with `name`; new rows: `create` with `printedName`). A row without a `name` but with a category gets the composed name, as the item form does. A row with neither is `Item #<ticket>`, as today. |
| D8 | **Re-importing.** For staff, a row with a category replaces the ticket's category and details wholesale, as `patch` already does. A row without a category leaves an existing description alone. A shop's own file still fills a ticket only once (Plan 38 D6). |
| D9 | **Speed.** The tree is read once per file, not per row. Matching is in memory, and the write path takes the pre-matched ids without re-reading the tree for every item. Target: 1,200 described rows in about 15 seconds locally. |
| D10 | **Who.** Unchanged: `ski_swap:manage` for staff's upload; a business seller for their own. |
| D11 | **Out of scope:** XLSX upload (staff convert to CSV), aliases for values, minting values from a file, a downloadable template. |

## Server

### Matching (`ski-swap/import-details.ts`, new, pure)

- `matchImportDetails(headers, rows, taxonomy)` takes the parsed headers and cells and the resolved tree, and returns per row `{ categoryId?, attributes: ItemAttributeInput[], unknown: { column, value, reason }[] }`, plus the file's unrecognized columns.
- Reasons: `unknown_category`, `unknown_value`, `needs_parent` (a Model without its Manufacturer), `out_of_range`, `not_a_number`.
- No database, no Nest: tested directly against a fixture tree.

### Parsing (`legacy-ticket.service.ts`)

- `parseItemCsv` keeps today's columns and also returns the raw header row and each row's cells, so the matcher can read the detail columns. Today's aliases (`name`/`item`/`title`…) win: a detail column can't be named `name` or `price`.

### Import (`item.service.ts`)

- `importItems(…, { dryRun })`: parse, check tickets, then match details against `taxonomy.resolve(orgId)` read once.
  - **Dry run:** return the rows with `outcome: 'ok'` and their `unknown`, and write nothing.
  - **Import:** errors or unknowns refuse the file (D4). Otherwise each row is written with its `categoryId` and matched `attributes` (ticket rows through `patch`, new rows through `create` with `printedName`), with `deferPos` as now.
- **D9:** `patch` and `create` take an optional pre-read tree for `resolveAnswers`. `resolveAnswers` uses it instead of `visibleNodes` when given.
- `ImportRowResult` gains `categoryId?` and `unknown?: { column, value, reason }[]`.

### Routes

- Both import routes take a `dryRun` field (`"true"`) on the same multipart body. No new route.

## Web

- **`ProxyItemImportModal.tsx`, `TicketItemImportModal.tsx`:** a **Check file** button before Import.
  - The result panel shows errors (as now), then the unknowns grouped by category, detail and value with row counts, each expandable to its lines, and a Copy button.
  - Then the summary of what would be written.
  - Import is enabled only after a clean check of the file that's chosen. Choosing the file again clears the check.
- **`importedSummary`** adds "… with a category" when some rows had one.
- A short help line in each modal names the new columns and links to the category list (the Item details page).

## This shop's file (one-off, not committed)

A script in the scratchpad turns `BMBW_Swap_PRINTABLE_Master.xlsx` into a D1 CSV:

- **Rows:** the 1,128 not sold in store (`SOLD` = LML dropped). `ticket` = ITEM #, `price` = PRICE (87587 has none and stays unpriced), `name` = BRAND/MODEL + size, as the shop wrote it (D7).
- **`category` from ITEM TYPE**, by a table for review. Proposed:
  - Ski boots: Jr Boot, SKI BOOT, Adult Boot.
  - Poles: JR POLE, JR. POLE, Jr Pole, Ski Pole, Pole, Adult Pole.
  - Skis: every ski and ski + binding spelling.
  - Snowboard: SB w/Bind, SB Snowbrd + Bind, sb/bdg, SNOWBOARD, SNOWBOARD/BIND, SNOWBOARD/BDG.
  - Snowboard boots: SB BOOT.
  - Jacket: JACKET, JKT.
  - Base layer: BASE LAYER.
  - Gloves: GLOVE, MITT.
  - Bag: SKI BAG, SNOWBOARD BAG.
  - Undecided, no category of ours: XC BOOT (2), SNOWBOARD BDG and SB BDG (4), FLEECE PULLOVER and MID LAYER (3).
- **Details:**
  - **Gender** Kids for the Jr types.
  - **Bindings included** Yes for ski and board types with a binding ("+ Bind", "/Bdg", "w/" in the model).
  - **Style** Mitten for MITT, Glove for GLOVE.
  - **Holds** Skis or Snowboard for bags.
  - **Condition** New for N, blank for U.
  - **MWK SIZE** goes to Mondopoint (ski boots), Length (skis, poles, snowboards), Size (snowboard boots, apparel, gloves).
  - **Manufacturer, Model, Color** split from BRAND/MODEL against production's tree (read-only). Leading words are matched to a manufacturer, then models under it, then color words. The shop's abbreviations ("Blk", "Wht", "Rossi") are expanded by a small table in the script, shown with the review.
- **Output:**
  - the CSV;
  - the type table;
  - and an unknown-values list in the D6 grouping, so values can be added before the real Check file.

## Rollout

1. Build and test locally against a copy of the database with the shop's converted file.
2. Deploy (asks first: the swap is live).
3. Issue tickets 86828–88019 to the shop. Take back the 64 sold in store.
4. Check file in production. Add the missing values. Check again until clean. Import.

## Tests

- **`import-details.spec.ts`:**
  - category by label, any case, trailing "s";
  - select values, any case;
  - Model only under its Manufacturer;
  - numbers with units, and out of range;
  - detail columns a row's category doesn't have, skipped;
  - unrecognized columns reported once;
  - nothing minted (no `freeText` in the output).
- **Import:**
  - Dry run writes nothing and returns unknowns.
  - A file with any unknown is refused whole, with nothing written.
  - Ticket rows `patch` with `categoryId`, `attributes` and the shop's `name`.
  - New rows `create` with `printedName`.
  - A row without a category leaves an existing description alone.
  - The tree is read once per file.
- **Web:** grouping unknowns by category, detail and value, with row counts.
- **Local timing:** the shop's file, 1,128 described rows, within D9's target.
