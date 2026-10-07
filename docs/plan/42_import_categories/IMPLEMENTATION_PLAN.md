# Plan 42: Categories and item details in a CSV import

## Goal

A seller's spreadsheet can say what each item is. Alongside `ticket`, `name`, `price` and `description`, a CSV import takes a `category` column and one column per item detail (`Manufacturer`, `Model`, `Size`, `Length`, `Color`…). Each cell is matched against our categories and values, so imported items are described the way the iPad and the item form describe them: they show in "Items by category", filter by detail, and carry their answers.

Both uploads say what the file should hold, in a few lines, and offer three downloads built from the patrol's own categories: a **template** of headers only, an **example CSV** whose every value matches, and a **list of categories and details** with every value spelled as the import expects.

Nothing is guessed and nothing is minted. A file with a category or value we don't have is refused at first, with every unknown listed, and nothing written. Whoever uploaded it then either fixes the file or adds the values (staff, globally or for the patrol) and uploads again, or chooses **Import anyway**, which imports the file without the unknowns.

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
| D2 | **Details are read per row, against that row's category.** One file can mix boots, skis and jackets. A detail column the row's category doesn't have, and an empty cell, are skipped without comment. A column that's neither one of ours nor any category's detail ("NEW/USED?", "Colour") is ignored, as unknown columns are today, and named once in the result ("Ignored columns: …") so a typo can still be spotted. |
| D3 | **Matching a value.**<br>• **Select:** the value's label, trimmed, case-insensitive. Approved values only, global and the patrol's.<br>• **Nested:** a detail that hangs under a value (Model under its Manufacturer) is matched only among that value's children. A Model without a matching Manufacturer on the row is unknown.<br>• **Number:** the leading number, read in the detail's unit ("163", "163cm", "24.5"). A cell marked in inches (`42"`, "42 in") is converted for a detail in cm (42" → 107). Outside the detail's range is unknown.<br>No aliases: "Rossi" doesn't find "Rossignol". A file is fixed by its maker, or the value is added. |
| D4 | **Refused first, then Import anyway.** Two kinds of problem, treated differently:<br>• **Row errors** (a bad or unknown ticket, a ticket that isn't this seller's, a price that isn't an amount, a ticket twice) refuse the file as today, with no override. The file has to change.<br>• **Unknowns** (an unknown category; an unknown value; a Model not under the row's Manufacturer; a number that isn't one, or is out of range) refuse the file too, with nothing written, and list every unknown (D6). The upload then offers **Import anyway**. On an import anyway, an unknown category leaves its row uncategorized and an unknown cell isn't stored; everything else on the row is written. The server takes the override as a field on the same upload (`acceptUnknown`), and refuses unknowns without it.<br>The same for staff and for a shop's own upload. |
| D5 | **Never minted.** The importer never sends `freeText`, so no file creates a value, pending or approved, whoever uploads it. Adding values stays a deliberate act in Item details. |
| D6 | **What a refused upload shows.** Import checks the whole file first (parse, tickets, matching), so a refusal writes nothing and there's no separate check step. The result shows:<br>• row errors by line, as now;<br>• **unknowns grouped**: "Ski boots · Manufacturer · Alpina · 31 rows", "Skis · Model · Mantra 84 (Volkl) · 4 rows", "Category · Ski/Bdg · 2 rows", each expandable to its lines, with a **Copy** button to hand the list to whoever adds the values;<br>• ignored columns (D2);<br>• what an import anyway would write: "1,128 tickets described, 1,071 with a category; 37 values won't be saved".<br>**Import anyway** appears only when there are unknowns and no row errors. |
| D7 | **The name.** A row with a `name` keeps it as the tag name, and the details are stored alongside (ticket rows: `patch` with `name`; new rows: `create` with `printedName`). A row without a `name` but with a category gets the composed name, as the item form does. A row with neither is `Item #<ticket>`, as today. |
| D8 | **Re-importing.** For staff, a row with a category replaces the ticket's category and details wholesale, as `patch` already does. A row without a category leaves an existing description alone. A shop's own file still fills a ticket only once (Plan 38 D6). |
| D9 | **Speed.** The tree is read once per file, not per row. Matching is in memory, and the write path takes the pre-matched ids without re-reading the tree for every item. Target: 1,200 described rows in about 15 seconds locally. |
| D10 | **Who.** Unchanged: `ski_swap:manage` for staff's upload; a business seller for their own. |
| D11 | **Out of scope:** XLSX upload (staff convert to CSV), aliases for values, minting values from a file, and keeping what an import anyway dropped: once values are added, re-importing the file (staff) is how its items get them. |
| D12 | **What the file should hold, said in the upload.** Both modals show the same short guide above the file picker, collapsed after the first upload of a session:<br><br>*One row per item, with a header row. Column names can be in any case.*<br>• **ticket**: the number on the ticket, digits only. Required, unless you generate SKUs.<br>• **name**: what the tag says. Kept as you wrote it.<br>• **price**: in dollars, like 45 or 19.50. Can be blank for a ticket.<br>• **description**: notes buyers see under the name.<br>• **category**: one of our categories, like Ski boots.<br>• **details**: one column per detail, headed with its name (Manufacturer, Size, Color…), one value per cell, spelled as in our lists. A detail only counts for a category that has it.<br>*Leave a cell blank to skip it. Put quotes around anything with a comma in it. Columns we don't use are ignored. A category or value we don't know stops the upload and is listed; you can fix the file, or import anyway without them.*<br><br>Below it: **Download a template**, **Download an example** and **Download categories and details** (D13). |
| D13 | **Three downloads, built from the patrol's tree when asked for**, so they're never out of date and include the patrol's own categories and values.<br>• **Template (`items-template.csv`):** the header row only. `ticket`, `name`, `price`, `description`, `category`, then every detail any category has (34 today), most used first: Manufacturer, Model, Condition, Color, Gender, Size, Type, Length… A shop deletes the columns it doesn't need.<br>• **Example (`items-example.csv`):** the header and four sample rows (skis with bindings, ski boots, a jacket, poles), with realistic values (Rossignol, 170, Mondopoint 26.5, Patagonia, M…). A sample value the tree doesn't have is left blank, and a sample category it doesn't have is dropped, so every value in the example matches; its ticket numbers are placeholders (1001–1004).<br>• **Categories and details (`categories-and-details.csv`):** one row per detail: `category`, `detail`, `only when` (the parent answer for a nested detail, like "Manufacturer = Rossignol" or "Type = Skis"), `kind`, and `values` (joined with " \| ") or the number range with its unit ("100–215 cm"). It answers "how do you spell that" before an upload has to. |

## Server

### Matching (`ski-swap/import-details.ts`, new, pure)

- `matchImportDetails(headers, rows, taxonomy)` takes the parsed headers and cells and the resolved tree, and returns per row `{ categoryId?, attributes: ItemAttributeInput[], unknown: { column, value, reason }[] }`, plus the file's ignored columns. `attributes` holds only what matched, so an import anyway writes it as it stands.
- Reasons: `unknown_category`, `unknown_value`, `needs_parent` (a Model without its Manufacturer), `out_of_range`, `not_a_number`.
- No database, no Nest: tested directly against a fixture tree.

### Parsing (`legacy-ticket.service.ts`)

- `parseItemCsv` keeps today's columns and also returns the raw header row and each row's cells, so the matcher can read the detail columns. Today's aliases (`name`/`item`/`title`…) win: a detail column can't be named `name` or `price`.

### Import (`item.service.ts`)

- `importItems(…, { acceptUnknown })`: parse, check tickets, then match details against `taxonomy.resolve(orgId)` read once.
  - **Row errors:** refuse, as today.
  - **Unknowns without `acceptUnknown`:** refuse, returning the rows with their `unknown` and outcome `'ok'`, and the ignored columns. Nothing is written.
  - **Otherwise:** each row is written with its `categoryId` and matched `attributes` (ticket rows through `patch`, new rows through `create` with `printedName`), with `deferPos` as now.
- **D9:** `patch` and `create` take an optional pre-read tree for `resolveAnswers`. `resolveAnswers` uses it instead of `visibleNodes` when given.
- `ImportRowResult` gains `categoryId?` and `unknown?: { column, value, reason }[]`. The response gains `ignoredColumns` and `refused: 'errors' | 'unknown' | null`.

### Downloads (`ski-swap/import-guide.ts`, new, pure)

- `templateCsv(taxonomy)`, `exampleCsv(taxonomy)` and `detailsCsv(taxonomy)` build D13's files from the resolved tree. The four sample rows are fixed in this file; each value is kept only if the tree has it.

### Routes

- Both import routes take an `acceptUnknown` field (`"true"`) on the same multipart body.
- `GET …/swaps/:swapId/items/import/template.csv`, `…/example.csv` and `…/details.csv` for staff (`ski_swap:manage`). The same three under `…/seller/me/items/import/` for a shop. Both serve `text/csv` as attachments, as the seller import template already does (`seller.controller.ts`, `import/template`).

## Web

- **`ProxyItemImportModal.tsx`, `TicketItemImportModal.tsx`:** Import as now. A refused upload shows D6's panel: row errors, then the grouped unknowns with Copy, then ignored columns and what an import anyway would write.
  - **Import anyway** sends the same file with `acceptUnknown`. It's shown only for unknowns without row errors, and confirms with the count of values that won't be saved.
  - Choosing a file again clears the result.
- **`importedSummary`** adds "… with a category" when some rows had one.
- **The guide (D12)** is one shared component, `ImportFileGuide.tsx`, used by both modals. It holds the copy and the three download links, and remembers being collapsed for the session.

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
  - Cross-country boots: XC BOOT.
  - Bindings (Type Snowboard): SNOWBOARD BDG, SB BDG.
  - Mid layer: FLEECE PULLOVER (Type Fleece), MID LAYER.
- **Details:**
  - **Gender** Kids for the Jr types.
  - **Bindings included** Yes for ski and board types with a binding ("+ Bind", "/Bdg", "w/" in the model).
  - **Style** Mitten for MITT, Glove for GLOVE.
  - **Holds** Skis or Snowboard for bags.
  - **Condition** New for N, blank for U.
  - **MWK SIZE** goes to Mondopoint (ski boots), Length (skis, poles, snowboards; poles in inches, which D3 converts), Size (snowboard boots, cross-country boots, apparel, gloves, snowboard bindings).
  - **Manufacturer, Model, Color** split from BRAND/MODEL against production's tree (read-only). Leading words are matched to a manufacturer, then models under it, then color words. The shop's abbreviations ("Blk", "Wht", "Rossi") are expanded by a small table in the script, shown with the review.
- **Output:**
  - the CSV;
  - the type table;
  - and an unknown-values list in the D6 grouping, so values can be added before the real upload.

## Rollout

1. Build and test locally against a copy of the database with the shop's converted file.
2. Deploy (asks first: the swap is live).
3. Issue tickets 86828–88019 to the shop. Take back the 64 sold in store.
4. Upload in production. Add the values it lists, or decide to import anyway. Import.

## Tests

- **`import-details.spec.ts`:**
  - category by label, any case, trailing "s";
  - select values, any case;
  - Model only under its Manufacturer;
  - numbers with units, and out of range;
  - detail columns a row's category doesn't have, skipped;
  - columns that aren't ours or a detail, ignored and named once;
  - nothing minted (no `freeText` in the output).
- **Import:**
  - A file with unknowns is refused whole, with nothing written, and its unknowns returned.
  - With `acceptUnknown` it imports: unknown categories leave rows uncategorized, unknown cells aren't stored, the rest is written.
  - Row errors refuse the file even with `acceptUnknown`.
  - Ticket rows `patch` with `categoryId`, `attributes` and the shop's `name`.
  - New rows `create` with `printedName`.
  - A row without a category leaves an existing description alone.
  - The tree is read once per file.
- **`import-guide.spec.ts`:**
  - The template's headers are the base columns, then every detail once, most used first, with no duplicates for details several categories share.
  - Every value in the example matches the committed `taxonomy.json`.
  - Sample values the tree lacks are blanked, and a missing category's row is dropped.
  - The categories-and-details file lists nested details with their "only when", and number ranges with units.
  - Values and labels with commas or quotes are escaped.
- **Web:** grouping unknowns by category, detail and value, with row counts.
- **Local timing:** the shop's file, 1,128 described rows, within D9's target.
